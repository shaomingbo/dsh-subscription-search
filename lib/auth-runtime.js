/**
 * Host-owned pi-ai subscription OAuth runtime: interactive device-code login,
 * owner-only persistence, locked token refresh, and secret-free status.
 * Standalone port of the DSH pi-ai auth runtime for out-of-tree installs.
 */

import { randomUUID } from 'node:crypto'
import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { OAuthCredentialFileStore } from './oauth-store.js'
import { CREDENTIAL_REFS } from './credential-refs.js'

const PROVIDERS = {
  'openai-codex': {
    displayName: 'ChatGPT Plus/Pro',
    loginLabel: 'Sign in with ChatGPT',
    verificationOrigins: ['https://auth.openai.com'],
  },
  xai: {
    displayName: 'Grok / X subscription',
    loginLabel: 'Sign in with SuperGrok or X Premium',
    verificationOrigins: ['https://auth.x.ai', 'https://accounts.x.ai', 'https://x.com'],
  },
}

const PROVIDER_ORDER = ['openai-codex', 'xai']

export class SubscriptionAuthError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SubscriptionAuthError'
    this.code = code
    this.details = details ?? {}
  }
}

function authProviderId(value) {
  if (value === 'openai-codex' || value === 'xai') return value
  throw new SubscriptionAuthError('PI_AI_AUTH_PROVIDER_UNKNOWN', `Subscription OAuth provider "${value}" is not supported`)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function abortable(operation, signal) {
  if (signal === undefined) return operation
  if (signal.aborted) {
    return Promise.reject(new SubscriptionAuthError('PI_AI_AUTH_ABORTED', 'Subscription authentication was cancelled'))
  }
  return new Promise((accept, reject) => {
    const onAbort = () => {
      reject(new SubscriptionAuthError('PI_AI_AUTH_ABORTED', 'Subscription authentication was cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        accept(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export class SubscriptionAuthRuntime {
  constructor({ filename, onChanged }) {
    this.filename = filename
    this.store = new OAuthCredentialFileStore({
      filename,
      watch: false,
      onChanged,
      onError: () => {},
    })
    this.logins = new Map()
    this.providerLogins = new Map()
    this.closed = false
    const models = createModels({ credentials: this.store })
    models.setProvider(openaiCodexProvider())
    models.setProvider(xaiProvider())
    this.models = models
  }

  async init() {
    await this.store.init()
  }

  async dispose() {
    this.closed = true
    for (const operation of [...this.logins.values()]) {
      if (operation.status.kind === 'pending') operation.controller.abort()
    }
    await Promise.all([...this.logins.values()].map(operation => operation.completion))
    this.logins.clear()
    this.providerLogins.clear()
    await this.store.dispose()
  }

  configured(provider) {
    return this.store.has(authProviderId(provider))
  }

  providers() {
    return PROVIDER_ORDER.map(provider => ({
      provider,
      displayName: PROVIDERS[provider].displayName,
      loginLabel: PROVIDERS[provider].loginLabel,
      configured: this.store.has(provider),
    }))
  }

  async resolveOAuth(provider, signal) {
    this.assertOpen()
    const id = authProviderId(provider)
    if (!this.store.has(id)) return undefined
    let result
    try {
      result = await abortable(this.models.getAuth(id), signal)
    } catch (error) {
      if (error instanceof SubscriptionAuthError && error.code === 'PI_AI_AUTH_ABORTED') throw error
      throw new SubscriptionAuthError(
        'PI_AI_AUTH_RESOLUTION_FAILED',
        `Could not resolve the ${PROVIDERS[id].displayName} subscription; sign in again under Settings → Search`,
        { ref: CREDENTIAL_REFS[id] },
      )
    }
    const auth = result?.auth
    const apiKey = auth?.apiKey
    if (auth === undefined || apiKey === undefined || apiKey.length === 0) {
      throw new SubscriptionAuthError(
        'PI_AI_AUTH_RESOLUTION_FAILED',
        `Could not resolve the ${PROVIDERS[id].displayName} subscription; sign in again under Settings → Search`,
        { ref: CREDENTIAL_REFS[id] },
      )
    }
    let headers = auth.headers
    if (id === 'openai-codex') {
      const credential = await this.store.read(id)
      const accountId = openAiAccountId(credential)
      if (accountId === undefined) {
        throw new SubscriptionAuthError(
          'PI_AI_AUTH_RESOLUTION_FAILED',
          `Could not resolve the ${PROVIDERS[id].displayName} subscription; sign in again under Settings → Search`,
          { ref: CREDENTIAL_REFS[id] },
        )
      }
      headers = { ...headers, 'chatgpt-account-id': accountId, originator: 'pi' }
    }
    return {
      apiKey,
      ...headers === undefined ? {} : { headers },
      ...auth.baseUrl === undefined ? {} : { baseURL: auth.baseUrl },
    }
  }

  async startLogin(provider, signal) {
    this.assertOpen()
    const id = authProviderId(provider)
    const previousId = this.providerLogins.get(id)
    if (previousId !== undefined) {
      const previous = this.logins.get(previousId)
      if (previous?.status.kind === 'pending') {
        throw new SubscriptionAuthError('PI_AI_AUTH_LOGIN_IN_PROGRESS', `${PROVIDERS[id].displayName} sign-in is already in progress`)
      }
      this.logins.delete(previousId)
      this.providerLogins.delete(id)
    }
    const operation = {
      loginId: randomUUID(),
      provider: id,
      controller: new AbortController(),
      challenge: deferred(),
      status: { kind: 'pending', provider: id },
      challengePublished: false,
      completion: Promise.resolve(),
    }
    this.logins.set(operation.loginId, operation)
    this.providerLogins.set(id, operation.loginId)
    operation.completion = this.runLogin(operation)
    try {
      return await abortable(operation.challenge.promise, signal)
    } catch (error) {
      if (signal?.aborted === true) {
        operation.controller.abort()
        await operation.completion
      }
      throw error
    }
  }

  loginStatus(loginId) {
    const operation = this.logins.get(loginId)
    if (operation === undefined) {
      throw new SubscriptionAuthError('PI_AI_AUTH_LOGIN_NOT_FOUND', 'Subscription sign-in was not found')
    }
    return operation.status
  }

  async cancelLogin(loginId) {
    const operation = this.logins.get(loginId)
    if (operation === undefined) {
      throw new SubscriptionAuthError('PI_AI_AUTH_LOGIN_NOT_FOUND', 'Subscription sign-in was not found')
    }
    if (operation.status.kind !== 'pending') return
    operation.controller.abort()
    await operation.completion
  }

  async logout(provider) {
    this.assertOpen()
    const id = authProviderId(provider)
    const loginId = this.providerLogins.get(id)
    if (loginId !== undefined) await this.cancelLogin(loginId)
    await this.models.logout(id)
  }

  async runLogin(operation) {
    const interaction = {
      signal: operation.controller.signal,
      prompt: prompt => this.answerPrompt(operation, prompt),
      notify: event => this.receiveAuthEvent(operation, event),
    }
    try {
      await this.models.login(operation.provider, 'oauth', interaction)
      if (!operation.challengePublished) {
        throw new SubscriptionAuthError('PI_AI_AUTH_LOGIN_UNSUPPORTED', 'The provider did not return a device-code challenge')
      }
      this.setLoginStatus(operation, { kind: 'succeeded', provider: operation.provider })
    } catch (error) {
      if (operation.controller.signal.aborted) {
        const cancelled = new SubscriptionAuthError('PI_AI_AUTH_ABORTED', 'Subscription authentication was cancelled')
        if (!operation.challengePublished) operation.challenge.reject(cancelled)
        this.setLoginStatus(operation, { kind: 'cancelled', provider: operation.provider })
        return
      }
      const safe = error instanceof SubscriptionAuthError
        ? error
        : new SubscriptionAuthError('PI_AI_AUTH_LOGIN_FAILED', `${PROVIDERS[operation.provider].displayName} sign-in failed; try again`)
      if (!operation.challengePublished) operation.challenge.reject(safe)
      this.setLoginStatus(operation, { kind: 'failed', provider: operation.provider, message: safe.message })
    }
  }

  answerPrompt(operation, prompt) {
    if (prompt.type === 'select' && prompt.options.some(option => option.id === 'device_code')) {
      return Promise.resolve('device_code')
    }
    return Promise.reject(new SubscriptionAuthError(
      'PI_AI_AUTH_LOGIN_UNSUPPORTED',
      `${PROVIDERS[operation.provider].displayName} requested an unsupported sign-in prompt`,
    ))
  }

  receiveAuthEvent(operation, event) {
    if (event.type !== 'device_code' || operation.challengePublished) return
    const verificationUri = this.verificationUri(operation.provider, event.verificationUri)
    if (event.userCode.length === 0) {
      throw new SubscriptionAuthError('PI_AI_AUTH_LOGIN_FAILED', 'The provider returned an empty device code')
    }
    const expiresAt = event.expiresInSeconds !== undefined
      && Number.isFinite(event.expiresInSeconds)
      && event.expiresInSeconds > 0
      ? Date.now() + event.expiresInSeconds * 1000
      : undefined
    operation.challengePublished = true
    operation.challenge.resolve({
      loginId: operation.loginId,
      provider: operation.provider,
      verificationUri,
      userCode: event.userCode,
      ...expiresAt === undefined ? {} : { expiresAt },
    })
  }

  verificationUri(provider, raw) {
    let url
    try {
      url = new URL(raw)
    } catch {
      throw new SubscriptionAuthError('PI_AI_AUTH_LOGIN_FAILED', 'The provider returned an invalid verification URL')
    }
    if (url.protocol !== 'https:' || !PROVIDERS[provider].verificationOrigins.includes(url.origin)) {
      throw new SubscriptionAuthError('PI_AI_AUTH_LOGIN_FAILED', 'The provider returned an untrusted verification URL')
    }
    return url.href
  }

  setLoginStatus(operation, status) {
    operation.status = status
  }

  assertOpen() {
    if (this.closed) throw new SubscriptionAuthError('PI_AI_AUTH_ABORTED', 'Subscription authentication is stopping')
  }
}

function openAiAccountId(credential) {
  if (typeof credential !== 'object' || credential === null || !('accountId' in credential)) return undefined
  const accountId = credential.accountId
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
}
