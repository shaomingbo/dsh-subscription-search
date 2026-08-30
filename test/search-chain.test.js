import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchChain, SearchChainError, DEFAULT_SETTINGS } from '../lib/search-chain.js'

const result = (url = 'https://example.com/') => ({ sources: [{ url }], truncated: false })
const backend = (id, search, available = () => true) => ({ id, label: id, search, available })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function chain(options = {}) {
  return new SearchChain({
    settings: { ...DEFAULT_SETTINGS, perLegTimeoutMs: 30, totalTimeoutMs: 100, ...options.settings },
    diagnosticsLimit: options.diagnosticsLimit ?? 4,
  })
}

test('search-chain/v1 registration is live, replace-safe, and disposed by identity', async () => {
  const searchChain = chain()
  const firstDispose = searchChain.register(backend('chatgpt', async () => result('https://first.example/')))
  assert.deepEqual(searchChain.list().backends.map(entry => [entry.id, entry.registered]), [
    ['chatgpt', true], ['grok', false], ['exa', false], ['deepseek', false],
  ])
  assert.equal((await searchChain.search({ query: 'q' })).sources[0].url, 'https://first.example/')

  const secondDispose = searchChain.register(backend('chatgpt', async () => result('https://second.example/')))
  firstDispose()
  assert.equal((await searchChain.search({ query: 'q' })).sources[0].url, 'https://second.example/')
  secondDispose()
  assert.equal(searchChain.list().backends[0].registered, false)
})

test('new backend ids join the tail without changing the default order', async () => {
  const searchChain = chain({ settings: { enabled: { chatgpt: false, grok: false, exa: false, deepseek: false } } })
  searchChain.register(backend('custom', async () => result('https://custom.example/')))
  assert.deepEqual(searchChain.list().settings.order, ['chatgpt', 'grok', 'exa', 'deepseek', 'custom'])
  assert.equal((await searchChain.search({ query: 'q' })).sources[0].url, 'https://custom.example/')
})

test('works without an account manager and follows ChatGPT → Grok → Exa → DeepSeek order', async () => {
  const calls = []
  const searchChain = chain()
  searchChain.register(backend('exa', async () => { calls.push('exa'); throw Object.assign(new Error('secret=do-not-leak'), { code: 'UPSTREAM_503' }) }))
  searchChain.register(backend('deepseek', async () => { calls.push('deepseek'); return result() }))

  assert.deepEqual(searchChain.list().backends.slice(0, 2).map(entry => [entry.id, entry.registered]), [
    ['chatgpt', false], ['grok', false],
  ])
  assert.deepEqual(await searchChain.search({ query: 'q' }), result())
  assert.deepEqual(calls, ['exa', 'deepseek'])
  assert.doesNotMatch(JSON.stringify(searchChain.list()), /do-not-leak/)
})

test('falls back after unavailable, failure, and per-leg timeout while preserving empty success', async () => {
  const calls = []
  const searchChain = chain({ settings: { perLegTimeoutMs: 15, totalTimeoutMs: 100 } })
  searchChain.register(backend('chatgpt', async () => { calls.push('chatgpt'); return result() }, () => false))
  searchChain.register(backend('grok', async () => { calls.push('grok'); throw new Error('bad') }))
  searchChain.register(backend('exa', async (_request, signal) => {
    calls.push('exa')
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }))
  searchChain.register(backend('deepseek', async () => { calls.push('deepseek'); return { sources: [], truncated: false } }))

  assert.deepEqual(await searchChain.search({ query: 'q' }), { sources: [], truncated: false })
  assert.deepEqual(calls, ['grok', 'exa', 'deepseek'])
  assert.deepEqual(searchChain.list().diagnostics.at(-1).attempts.map(entry => entry.status), [
    'unavailable', 'error', 'timeout', 'empty',
  ])
})

test('availability probing is inside the per-leg deadline and falls back', async () => {
  const calls = []
  const searchChain = chain({ settings: { perLegTimeoutMs: 10, totalTimeoutMs: 80 } })
  searchChain.register(backend('chatgpt', async () => { calls.push('chatgpt-search'); return result() }, async signal => {
    calls.push('chatgpt-available')
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }))
  searchChain.register(backend('grok', async () => { calls.push('grok'); return result('https://grok.example/') }))
  assert.equal((await searchChain.search({ query: 'q' })).sources[0].url, 'https://grok.example/')
  assert.deepEqual(calls, ['chatgpt-available', 'grok'])
  assert.equal(searchChain.list().diagnostics.at(-1).attempts[0].status, 'timeout')
})

test('total timeout aborts the active leg and does not continue fallback', async () => {
  const calls = []
  let aborted = false
  const searchChain = chain({ settings: { perLegTimeoutMs: 100, totalTimeoutMs: 20 } })
  searchChain.register(backend('chatgpt', async (_request, signal) => {
    calls.push('chatgpt')
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
  }))
  searchChain.register(backend('grok', async () => { calls.push('grok'); return result() }))

  await assert.rejects(searchChain.search({ query: 'q' }), error => error instanceof SearchChainError && error.code === 'SEARCH_TOTAL_TIMEOUT')
  assert.equal(aborted, true)
  assert.deepEqual(calls, ['chatgpt'])
})

test('caller cancellation aborts the active leg immediately and remains cancellation', async () => {
  const controller = new AbortController()
  let observed = false
  let started
  const ready = new Promise(resolve => { started = resolve })
  const searchChain = chain()
  searchChain.register(backend('chatgpt', async (_request, signal) => {
    started()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { observed = true; reject(signal.reason) }, { once: true }))
  }))
  const pending = searchChain.search({ query: 'q' }, undefined, controller.signal)
  await ready
  controller.abort()
  await assert.rejects(pending, error => error instanceof SearchChainError && error.code === 'SEARCH_CANCELLED')
  assert.equal(observed, true)
})

test('policy controls enabled/order/timeouts without exposing a DAG', async () => {
  const calls = []
  const searchChain = chain()
  for (const id of ['chatgpt', 'grok', 'exa', 'deepseek']) {
    searchChain.register(backend(id, async () => { calls.push(id); return result(`https://${id}.example/`) }))
  }
  const value = await searchChain.search({ query: 'q' }, {
    version: 1,
    enabled: { chatgpt: false, grok: true, exa: true, deepseek: true },
    order: ['deepseek', 'exa', 'grok', 'chatgpt'],
    perLegTimeoutMs: 20,
    totalTimeoutMs: 50,
  })
  assert.equal(value.sources[0].url, 'https://deepseek.example/')
  assert.deepEqual(calls, ['deepseek'])
  assert.equal('dag' in searchChain.list().settings, false)
})

test('exhaustion and bounded diagnostics contain only stable codes and metadata', async () => {
  const searchChain = chain({ diagnosticsLimit: 2 })
  searchChain.register({ ...backend('exa', async () => { throw Object.assign(new Error('api-key=super-secret'), { code: 'BAD CODE secret' }) }), label: 'super-secret-label' })
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(searchChain.search({ query: `private query ${index}` }), error => {
      assert.equal(error.code, 'SEARCH_CHAIN_EXHAUSTED')
      assert.doesNotMatch(error.message, /private query|super-secret/)
      return true
    })
  }
  const status = searchChain.list()
  assert.equal(status.protocol, 'search-chain/v1')
  assert.equal(status.diagnostics.length, 2)
  assert.doesNotMatch(JSON.stringify(status), /private query|super-secret/)
  assert.equal(status.backends.find(entry => entry.id === 'exa').label, 'Exa')
  assert.ok(status.diagnostics.every(entry => entry.attempts.length <= 4))
})

test('invalid registration and requests fail at the public seam', async () => {
  const searchChain = chain()
  assert.throws(() => searchChain.register({ id: 'bad id', search() {} }), /backend id/)
  await assert.rejects(searchChain.search({ query: '' }), error => error.code === 'SEARCH_INVALID_REQUEST')
  await wait(0)
})
