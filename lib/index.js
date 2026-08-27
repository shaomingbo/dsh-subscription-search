/**
 * Host half of dsh-subscription-search: OAuth device-code login for ChatGPT
 * and Grok, fresh-token sync into the credentials seam, pi-ai model route
 * provisioning through settings (per-provider merge), the loopback-only
 * subscription channel, and the internal-chain web search provider.
 */

import { homedir } from 'node:os'
import { SubscriptionAuthRuntime } from './auth-runtime.js'
import { SubscriptionChainSearchProvider } from './chain-search.js'
import { CREDENTIAL_REFS } from './credential-refs.js'
import { createCredentialSynchronizer } from './credential-sync.js'
import { createUsageService } from './usage.js'

const CHANNEL = '/subscription-search'

const GROK_ROUTE_MODELS = [{
  id: 'grok-4.6',
  name: 'Grok 4.6',
  contextWindow: 500000,
  maxTokens: 500000,
  input: ['text', 'image'],
  reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
}]

const ENVELOPE_CODES = new Set(['cancelled', 'internal'])

/** User-initiated cancellations keep a precise, still schema-legal envelope code. */
const CANCELLED_CODES = new Set(['PI_AI_AUTH_ABORTED'])

/**
 * Failures meaning "the stored subscription credential is unusable" can carry
 * the schema's credential-rejected details — but only when a genuine
 * `details.ref` rode along; anything else falls back to the generic envelope.
 */
const CREDENTIAL_CODES = new Set(['PI_AI_AUTH_RESOLUTION_FAILED'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Fold any internal error code + details into a schema-legal outcome. */
export function envelopeOutcome(code, details) {
  if (typeof code === 'string') {
    if (ENVELOPE_CODES.has(code)) return { code, details: {} }
    if (CREDENTIAL_CODES.has(code) && isRecord(details) && typeof details.ref === 'string') {
      return { code: 'credential-rejected', details: { ref: details.ref } }
    }
    if (CANCELLED_CODES.has(code)) return { code: 'cancelled', details: {} }
  }
  return { code: 'internal', details: {} }
}

/** Fold any internal error code into an envelope-legal one. */
export function envelopeCode(code) {
  return envelopeOutcome(code).code
}

/**
 * Normalize an RPC failure at the channel boundary: private error
 * namespaces (PI_AI_AUTH_*, WEB_*, USAGE_*, …) never reach the client as
 * discriminator codes. The original code stays diagnosable as a `[CODE] `
 * message prefix while the wire code remains schema-legal.
 */
function failure(message, code = 'internal', details) {
  const safe = envelopeOutcome(code, details)
  const tag = typeof code === 'string' && code !== safe.code ? `[${code}] ` : ''
  return { ok: false, error: { code: safe.code, message: `${tag}${message}`, details: safe.details } }
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
  const filename = `${process.env.DSH_HOME ?? `${homedir()}/.dsh`}/.oauth.json`

  let synchronizer
  const auth = new SubscriptionAuthRuntime({
    filename,
    onChanged: providerId => {
      if (providerId === 'openai-codex' || providerId === 'xai') void synchronizer?.background(providerId, 'store')
    },
  })
  synchronizer = createCredentialSynchronizer({ auth, credentials: ctx.credentials, logger: ctx.logger })
  const usage = createUsageService({
    auth,
    sync: (provider, reason) => synchronizer.sync(provider, reason),
  })
  void auth.init()

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
      await synchronizer.sync(oauthProvider, 'request')
      yield* next()
    })()
  })

  // Periodic background refresh.
  ctx.interval(() => {
    void synchronizer.background('openai-codex', 'timer')
    void synchronizer.background('xai', 'timer')
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
        usage.clear(provider)
        return success({})
      }
      if (endpoint === 'usage') {
        const { refresh } = requireObject(payload)
        return success({ providers: await usage.fetchAll({ refresh: refresh === true, signal }) })
      }
      return failure(`unknown subscription-search endpoint: ${endpoint}`)
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : 'subscription-search request failed',
        error?.code,
        error?.details,
      )
    }
  }, { authority: 'loopback' })

  ctx.on('dispose', () => {
    usage.clear()
    void auth.dispose()
  })
}
