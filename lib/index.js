/** Search-only Host composition for dsh-subscription-search. */

import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createDeepSeekBackend, createExaBackend, createOllamaBackend, SubscriptionChainSearchProvider } from './chain-search.js'
import { DEFAULT_SETTINGS, SearchChain, SearchChainError, SEARCH_CHAIN_PROTOCOL } from './search-chain.js'

export { createDeepSeekBackend, createExaBackend, createOllamaBackend, SubscriptionChainSearchProvider } from './chain-search.js'
export { DEFAULT_SETTINGS, SearchChain, SearchChainError, SEARCH_CHAIN_PROTOCOL } from './search-chain.js'

const CHANNEL = '/subscription-search'
export const SETTINGS_NAMESPACE = 'dsh-subscription-search'
export const SETTINGS_NS = settingsNamespace(SETTINGS_NAMESPACE)
export const SEARCH_CHAIN_SERVICE = 'searchChain'
export const Config = z.object({
  version: z.const(1).default(1),
  enabled: z.dict(z.boolean()).default({ chatgpt: true, grok: true, ollama: true, exa: true, deepseek: true }),
  order: z.array(z.string()).default(['chatgpt', 'grok', 'ollama', 'exa', 'deepseek']),
  perLegTimeoutMs: z.number().step(1).min(1).max(300_000).default(DEFAULT_SETTINGS.perLegTimeoutMs),
  totalTimeoutMs: z.number().step(1).min(1).max(300_000).default(DEFAULT_SETTINGS.totalTimeoutMs),
})

function success(value) {
  return { ok: true, value }
}

function failure(error) {
  const cancelled = error?.code === 'SEARCH_CANCELLED'
  return {
    ok: false,
    error: {
      code: cancelled ? 'cancelled' : 'internal',
      message: cancelled ? 'Search cancelled' : 'Subscription search request failed',
      details: {},
    },
  }
}

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SearchChainError('SEARCH_INVALID_REQUEST', 'Request payload must be an object')
  }
  return payload
}

/** Secret-free loopback facade retained at /subscription-search. */
export function createRpcHandler({ searchChain, settings }) {
  return async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'status' || endpoint === 'providers') return success(searchChain.list())
      if (endpoint === 'search') {
        const request = requireObject(payload)
        return success(await searchChain.search(request, undefined, signal))
      }
      if (endpoint === 'update-settings') {
        const { settings: next } = requireObject(payload)
        if (!next || typeof next !== 'object' || next.version !== 1) {
          throw new SearchChainError('SEARCH_INVALID_REQUEST', 'Search settings version must be 1')
        }
        const normalized = Config(next)
        await settings.update(SETTINGS_NS, normalized)
        searchChain.configure(normalized)
        return success(searchChain.list())
      }
      return failure(new SearchChainError('SEARCH_INVALID_REQUEST', 'Unknown subscription-search endpoint'))
    } catch (error) {
      return failure(error)
    }
  }
}

export const name = 'dsh-subscription-search'
export const inject = ['connection', 'credentials', 'web']

export function apply(ctx, config = {}) {
  const entry = Config(config)
  const searchChain = new SearchChain({ settings: entry })
  let current = () => entry
  installSettingsSection(ctx, SETTINGS_NS, Config, entry, {
    setSource(source) { current = source },
    onChange() { searchChain.configure(current()) },
  })

  const disposeExa = searchChain.register(createExaBackend({ credentials: ctx.credentials }))
  const disposeDeepSeek = searchChain.register(createDeepSeekBackend({ credentials: ctx.credentials }))
  const ollamaBackend = createOllamaBackend({ credentials: ctx.credentials })
  const disposeOllama = searchChain.register(ollamaBackend)
  void ollamaBackend.refreshAvailability()
  // Credential-gated participation: each search re-resolves the ref itself, and this
  // public committed-change event only keeps the status badge current. Process-env
  // changes are unobservable and never emit; the next search's gate still sees them.
  const offReferenceUpdated = ctx.on('credentials/reference-updated', ref => {
    if (ref === 'OLLAMA_API_KEY') void ollamaBackend.refreshAvailability()
  })

  // Host protocol for optional account plugins. Such a plugin may appear later,
  // register callable ChatGPT/Grok adapters, then dispose them independently.
  ctx.provide(SEARCH_CHAIN_SERVICE, searchChain)

  // dsh-web still consumes one scalar provider id; this adapter forwards only.
  const disposeWeb = ctx.web.registerSearchProvider(new SubscriptionChainSearchProvider(searchChain))
  const settings = {
    async update(namespace, next) {
      const service = ctx.get('settings')
      if (service === undefined || service.get(namespace) === undefined) {
        throw new Error('search settings are not currently available')
      }
      await service.update(namespace, next)
    },
  }
  ctx.connection.rpc.handle(CHANNEL, createRpcHandler({ searchChain, settings }), { authority: 'loopback' })

  ctx.on('dispose', () => {
    disposeExa()
    disposeDeepSeek()
    disposeOllama()
    if (typeof offReferenceUpdated === 'function') offReferenceUpdated()
    if (typeof disposeWeb === 'function') disposeWeb()
  })
}
