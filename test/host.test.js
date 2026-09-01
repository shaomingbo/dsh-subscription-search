import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, createRpcHandler, SearchChain, SEARCH_CHAIN_SERVICE } from '../lib/index.js'

function context(section, withSettings = true, credentials = { async resolve() { return undefined } }) {
  const provided = new Map()
  const providers = []
  const handlers = new Map()
  const disposal = []
  const settings = {
    value: section,
    updates: [],
    registered: false,
    watchers: [],
    get: () => settings.registered ? settings.value : undefined,
    register(_key, schema, { base }) {
      settings.registered = true
      settings.value = section === undefined ? schema(base) : schema({ ...base, ...section })
      return { get: () => settings.value, watch(callback) { settings.watchers.push(callback) } }
    },
    async update(key, value) {
      settings.updates.push([key, value]); settings.value = value
      settings.watchers.forEach(callback => callback())
    },
  }
  return {
    ctx: {
      credentials,
      settings,
      web: { registerSearchProvider(provider) { providers.push(provider); return () => providers.splice(providers.indexOf(provider), 1) } },
      connection: { rpc: { handle(path, handler, options) { handlers.set(path, { handler, options }) } } },
      provide(id, value) { provided.set(id, value) },
      get(id) { return withSettings && id === 'settings' ? settings : undefined },
      inject(ids, callback) { if (withSettings && ids.includes('settings')) callback({ settings, effect() {}, fiber: { state: 1 } }) },
      on(event, callback) { if (event === 'dispose') disposal.push(callback) },
    },
    provided,
    providers,
    handlers,
    settings,
    dispose() { disposal.forEach(callback => callback()) },
  }
}

test('Host starts with no account plugin and provides search-chain/v1 before dynamic registration', async () => {
  const world = context(undefined)
  apply(world.ctx)
  const chain = world.provided.get(SEARCH_CHAIN_SERVICE)
  assert.ok(chain instanceof SearchChain)
  assert.equal(world.providers[0].id, 'subscription-search')
  assert.deepEqual((await chain.list()).backends.map(entry => [entry.id, entry.registered]), [
    ['chatgpt', false], ['grok', false], ['ollama', true], ['exa', true], ['deepseek', true],
  ])

  const unregister = chain.register({ id: 'chatgpt', label: 'ChatGPT account', async search() { return { sources: [], truncated: false } } })
  assert.equal((await chain.list()).backends[0].registered, true)
  assert.deepEqual(await world.providers[0].search({ query: 'q' }), { sources: [], truncated: false })
  unregister()
  assert.equal((await chain.list()).backends[0].registered, false)
})

test('Host search chain starts when the optional settings manager is absent', async () => {
  const world = context(undefined, false)
  apply(world.ctx)
  const chain = world.provided.get(SEARCH_CHAIN_SERVICE)
  assert.ok(chain instanceof SearchChain)
  assert.deepEqual((await chain.list()).settings.order, ['chatgpt', 'grok', 'ollama', 'exa', 'deepseek'])
  const response = await world.handlers.get('/subscription-search').handler('update-settings', { settings: (await chain.list()).settings })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'internal')
})

test('built-in backends surface credential configuration through the status RPC', async () => {
  const describeLog = []
  const world = context(undefined, true, {
    async describe(ref) { describeLog.push(ref); return { configured: ref === 'EXA_API_KEY' } },
    async resolve() { throw new Error('status probes must not resolve values') },
  })
  apply(world.ctx)
  const response = await world.handlers.get('/subscription-search').handler('status', {}, undefined)
  assert.equal(response.ok, true)
  assert.deepEqual(response.value.backends.map(entry => [entry.id, entry.availability]), [
    ['chatgpt', 'unregistered'], ['grok', 'unregistered'], ['ollama', 'unavailable'],
    ['exa', 'available'], ['deepseek', 'unavailable'],
  ])
  assert.deepEqual(describeLog, ['EXA_API_KEY', 'DEEPSEEK_API_KEY', 'OLLAMA_API_KEY'])
  assert.doesNotMatch(JSON.stringify(response), /status probes must not resolve/)
})

test('the Ollama leg participates only while OLLAMA_API_KEY is configured', async () => {
  const world = context(undefined, true, {
    async describe(ref) { return { configured: ref === 'OLLAMA_API_KEY' } },
    async resolve() { throw new Error('vault secret leaked') },
  })
  apply(world.ctx)
  const searchChain = world.provided.get(SEARCH_CHAIN_SERVICE)
  const response = await world.handlers.get('/subscription-search').handler('search', { query: 'q' }, undefined)
  assert.equal(response.ok, false)
  assert.deepEqual(searchChain.list().diagnostics.at(-1).attempts.map(entry => [entry.id, entry.status]), [
    ['chatgpt', 'unavailable'], ['grok', 'unavailable'], ['ollama', 'error'], ['exa', 'unavailable'], ['deepseek', 'unavailable'],
  ])
  const status = await searchChain.probe()
  assert.equal(status.backends.find(entry => entry.id === 'ollama').availability, 'available')
  assert.doesNotMatch(JSON.stringify(status), /vault secret/)
  world.dispose()
})

test('compatibility RPC is loopback, secret-free, and only status/settings/search forwarding', async () => {
  const world = context(undefined)
  apply(world.ctx)
  const registration = world.handlers.get('/subscription-search')
  assert.deepEqual(registration.options, { authority: 'loopback' })

  const status = await registration.handler('providers', {}, undefined)
  assert.equal(status.ok, true)
  assert.equal(status.value.protocol, 'search-chain/v1')
  assert.doesNotMatch(JSON.stringify(status), /accessToken|refreshToken|credentialValue|Bearer /i)

  const legacy = await registration.handler('start-login', { provider: 'openai-codex', token: 'top-secret' }, undefined)
  assert.equal(legacy.ok, false)
  assert.doesNotMatch(JSON.stringify(legacy), /top-secret|openai-codex/)
})

test('versioned settings round-trip through the Host facade', async () => {
  const searchChain = new SearchChain()
  const settings = { updates: [], async update(key, value) { this.updates.push([key, value]) } }
  const rpc = createRpcHandler({ searchChain, settings })
  const next = {
    version: 1,
    enabled: { chatgpt: false, grok: true, ollama: true, exa: true, deepseek: false },
    order: ['exa', 'grok', 'chatgpt', 'deepseek', 'ollama'],
    perLegTimeoutMs: 1234,
    totalTimeoutMs: 5678,
  }
  const response = await rpc('update-settings', { settings: next })
  assert.equal(response.ok, true)
  assert.deepEqual(response.value.settings, next)
  assert.deepEqual(settings.updates, [['dsh-subscription-search', next]])
})

test('failed settings persistence rolls the live chain back', async () => {
  const searchChain = new SearchChain()
  const before = (await searchChain.list()).settings
  const rpc = createRpcHandler({ searchChain, settings: { async update() { throw new Error('disk secret detail') } } })
  const response = await rpc('update-settings', { settings: { ...before, order: [...before.order].reverse() } })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'internal')
  assert.deepEqual((await searchChain.list()).settings, before)
  assert.doesNotMatch(JSON.stringify(response), /disk secret/)
})

test('RPC search never serializes backend errors or request text', async () => {
  const searchChain = new SearchChain({ settings: { version: 1, enabled: { exa: true }, order: ['exa'], perLegTimeoutMs: 20, totalTimeoutMs: 40 } })
  searchChain.register({ id: 'exa', async search() { throw new Error('secret-value-from-upstream') } })
  const rpc = createRpcHandler({ searchChain, settings: { async update() {} } })
  const response = await rpc('search', { query: 'private-query-value' })
  assert.equal(response.ok, false)
  assert.doesNotMatch(JSON.stringify(response), /secret-value|private-query/)
})
