/**
 * Host half of dsh-subscription-search: OAuth device-code login for ChatGPT
 * and Grok, fresh-token sync into the credentials seam, pi-ai model route
 * provisioning through settings (per-provider merge), the loopback-only
 * subscription channel, and the internal-chain web search provider.
 */

import { homedir } from 'node:os'
import { SubscriptionAuthRuntime } from './auth-runtime.js'
import { SubscriptionChainSearchProvider } from './chain-search.js'

const CHANNEL = '/subscription-search'

const CREDENTIAL_REFS = {
  'openai-codex': 'OPENAI_CODEX_ACCESS_TOKEN',
  xai: 'GROK_BUILD_ACCESS_TOKEN',
}

const GROK_ROUTE_MODELS = [{
  id: 'grok-4.6',
  name: 'Grok 4.6',
  contextWindow: 500000,
  maxTokens: 500000,
  input: ['text', 'image'],
  reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
}]

function failure(message, code = 'internal') {
  return { ok: false, error: { code, message, details: {} } }
}

function success(value) {
  return { ok: true, value }
}

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('request payload must be an object')
  }
  return payload
}

/** Published DSH authenticates openai-codex only through apiKeyEnv, not native OAuth. */
export function openaiCodexRoutePatch(existing) {
  return {
    displayName: existing?.displayName ?? 'OpenAI Codex (ChatGPT subscription)',
    apiKeyEnv: CREDENTIAL_REFS['openai-codex'],
  }
}

/** Provision or repair the openai-codex route so ChatGPT models can authenticate. */
async function ensureOpenAiCodexRoute(settings) {
  const existing = settings.get('llm-pi-ai')?.providers?.['openai-codex']
  if (existing?.apiKeyEnv === CREDENTIAL_REFS['openai-codex']) return
  await settings.update('llm-pi-ai', {
    providers: {
      'openai-codex': openaiCodexRoutePatch(existing),
    },
  })
}

/** Provision the grok-build route through the shared xAI subscription login. */
async function ensureGrokBuildRoute(settings) {
  const section = settings.get('llm-pi-ai')
  const existing = section?.providers?.['grok-build']
  if (existing !== undefined) return
  await settings.update('llm-pi-ai', {
    providers: {
      'grok-build': {
        displayName: 'Grok (X subscription)',
        apiKeyEnv: CREDENTIAL_REFS.xai,
        api: 'openai-responses',
        baseURL: 'https://api.x.ai/v1',
        reasoning: 'high',
        models: GROK_ROUTE_MODELS,
      },
    },
  })
}

export const name = 'dsh-subscription-search'
export const inject = ['connection', 'credentials', 'settings', 'timer', 'web']

export function apply(ctx) {
  const home = ctx.get('dshHome')
  const filename = `${process.env.DSH_HOME ?? `${homedir()}/.dsh`}/.oauth.json`

  const auth = new SubscriptionAuthRuntime({
    filename,
    onChanged: providerId => {
      if (providerId === 'openai-codex' || providerId === 'xai') void syncCredential(providerId, 'store')
    },
  })
  void auth.init()

  let syncInFlight
  /** Refresh (if needed) and push the fresh access token into the credentials seam. */
  const syncCredential = async (provider, reason) => {
    if (syncInFlight) return syncInFlight
    syncInFlight = (async () => {
      if (!auth.configured(provider)) return
      const resolved = await auth.resolveOAuth(provider)
      if (resolved === undefined || resolved.apiKey.length === 0) return
      const ref = CREDENTIAL_REFS[provider]
      const current = await ctx.credentials.resolve(ref)
      if (current?.value !== resolved.apiKey) {
        await ctx.credentials.set(ref, resolved.apiKey)
        ctx.logger.info('dsh-subscription-search: synchronized credential %s (%s)', ref, reason)
      }
    })().catch(error => {
      ctx.logger.warn('dsh-subscription-search: %s sync failed: %s', reason, error instanceof Error ? error.message : String(error))
    }).finally(() => {
      syncInFlight = undefined
    })
    return syncInFlight
  }

  // Provision model routes once settings is live; a conflict with a user-owned
  // route keeps the user's section and only costs a diagnostic. Runs on a
  // microtask so the plugin fiber settles before the writes.
  void Promise.resolve().then(async () => {
    for (const provision of [ensureOpenAiCodexRoute, ensureGrokBuildRoute]) {
      try {
        await provision(ctx.settings)
      } catch (error) {
        ctx.logger.warn('dsh-subscription-search: route provisioning failed: %s', error instanceof Error ? error.message : String(error))
      }
    }
  })

  // Keep the model credential fresh before any openai-codex / grok-build stream.
  ctx.on('llm/stream', (options, next) => {
    const provider = options?.provider
    if (provider !== 'openai-codex' && provider !== 'grok-build') return next()
    const oauthProvider = provider === 'openai-codex' ? 'openai-codex' : 'xai'
    return (async function* () {
      await syncCredential(oauthProvider, 'request')
      yield* next()
    })()
  })

  // Periodic background refresh.
  ctx.interval(() => {
    void syncCredential('openai-codex', 'timer')
    void syncCredential('xai', 'timer')
  }, 10 * 60 * 1000)

  // Internal-chain search provider under the scalar searchProvider id.
  ctx.web.registerSearchProvider(new SubscriptionChainSearchProvider({
    auth,
    credentials: ctx.credentials,
  }))

  // Loopback-only subscription channel consumed by the client section.
  ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'providers') return success({ providers: auth.providers() })
      if (endpoint === 'start-login') {
        const { provider } = requireObject(payload)
        return success({ challenge: await auth.startLogin(provider, signal) })
      }
      if (endpoint === 'login-status') {
        const { loginId } = requireObject(payload)
        return success({ status: auth.loginStatus(loginId) })
      }
      if (endpoint === 'cancel-login') {
        const { loginId } = requireObject(payload)
        await auth.cancelLogin(loginId)
        return success({})
      }
      if (endpoint === 'logout') {
        const { provider } = requireObject(payload)
        await auth.logout(provider)
        return success({})
      }
      return failure(`unknown subscription-search endpoint: ${endpoint}`)
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'subscription-search request failed', error?.code)
    }
  }, { authority: 'loopback' })

  ctx.on('dispose', () => {
    void auth.dispose()
  })
}
