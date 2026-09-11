/** Search-only Host composition for dsh-subscription-search. */

import z from '@deepseek-ai/schemastery'
import { createDeepSeekBackend, createExaBackend, createOllamaBackend, SubscriptionChainSearchProvider } from './chain-search.js'
import { DEFAULT_SETTINGS, SearchChain, SearchChainError, SEARCH_CHAIN_PROTOCOL } from './search-chain.js'

export { createDeepSeekBackend, createExaBackend, createOllamaBackend, SubscriptionChainSearchProvider } from './chain-search.js'
export { DEFAULT_SETTINGS, SearchChain, SearchChainError, SEARCH_CHAIN_PROTOCOL } from './search-chain.js'

const CHANNEL = '/subscription-search'
export const SETTINGS_NAMESPACE = 'dsh-subscription-search'
export const SETTINGS_NS = SETTINGS_NAMESPACE
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
      if (endpoint === 'status' || endpoint === 'providers') return success(await searchChain.probe())
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
        return success(await searchChain.probe())
      }
      return failure(new SearchChainError('SEARCH_INVALID_REQUEST', 'Unknown subscription-search endpoint'))
    } catch (error) {
      return failure(error)
    }
  }
}

export const name = 'dsh-subscription-search'
export const inject = ['connection', 'credentials', 'settings', 'web', 'webServer']

export function apply(ctx, config = {}) {
  const entry = Config(config)
  const searchChain = new SearchChain({ settings: entry })
  let current = () => entry
  ctx.settings.installSection(ctx, SETTINGS_NS, Config, entry, {
    setSource(source) { current = source },
    onChange() { searchChain.configure(current()) },
  })

  const disposeExa = searchChain.register(createExaBackend({ credentials: ctx.credentials }))
  const disposeDeepSeek = searchChain.register(createDeepSeekBackend({ credentials: ctx.credentials }))
  const disposeOllama = searchChain.register(createOllamaBackend({ credentials: ctx.credentials }))

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
  const rpcHandler = createRpcHandler({ searchChain, settings })
  try {
    ctx.connection.rpc.handle(CHANNEL, rpcHandler, { authority: 'loopback' })
  } catch (error) {
    // 0.1.5 Connection mounts generic channels onto the caller fiber's
    // webServer. The Connection service context itself does not inject
    // webServer, so handle() fails closed here; the /api Fetch routes below
    // are the 0.1.5 browser transport.
    if (!String(error?.message ?? error).includes('webServer')) throw error
  }
  if (typeof ctx.connection.fetch?.register === 'function') {
    for (const endpoint of ['status', 'providers', 'search', 'update-settings']) {
      ctx.connection.fetch.register({
        path: `/api/subscription-search/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            return new Response('content type must be application/json', { status: 415 })
          }
          let body
          try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
          const expectedMethod = `subscription-search/${endpoint}`
          if (body?.type !== 'client-request' || typeof body.rpcId !== 'string' || (body.method !== endpoint && body.method !== expectedMethod)) {
            return Response.json({ type: 'server-response', rpcId: body?.rpcId ?? 'invalid-request', result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } } })
          }
          const result = await rpcHandler(endpoint, body.payload, request.signal)
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result })
        },
      })
    }
  }

  ctx.on('dispose', () => {
    disposeExa()
    disposeDeepSeek()
    disposeOllama()
    if (typeof disposeWeb === 'function') disposeWeb()
  })
}
