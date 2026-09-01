import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekBackend, createExaBackend, createOllamaBackend } from '../lib/chain-search.js'

function credentials(expected, secret) {
  return { async resolve(ref) { assert.equal(ref, expected); return { value: secret } } }
}

test('Exa resolves the ordinary credential ref and maps an empty result', async () => {
  let init
  const backend = createExaBackend({
    credentials: credentials('EXA_API_KEY', 'exa-secret'),
    async fetchImpl(_url, value) { init = value; return { ok: true, async json() { return { results: [] } } } },
  })
  assert.deepEqual(await backend.search({ query: 'q' }, new AbortController().signal), { sources: [], truncated: false })
  assert.equal(init.headers.authorization, 'Bearer exa-secret')
})

test('DeepSeek resolves the ordinary credential ref and maps tool results', async () => {
  const backend = createDeepSeekBackend({
    credentials: credentials('DEEPSEEK_API_KEY', 'deepseek-secret'),
    async fetchImpl(_url, init) {
      assert.equal(init.headers['x-api-key'], 'deepseek-secret')
      return { ok: true, async json() { return { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/', title: 'Example' }] }] } } }
    },
  })
  assert.deepEqual(await backend.search({ query: 'q' }, new AbortController().signal), {
    sources: [{ url: 'https://example.com/', title: 'Example' }], truncated: false,
  })
})

test('built-in credential failures expose only a stable code', async () => {
  const backend = createExaBackend({ credentials: { async resolve() { throw new Error('vault secret leaked') } } })
  await assert.rejects(backend.search({ query: 'q' }), error => {
    assert.equal(error.code, 'SEARCH_CREDENTIAL_MISSING')
    assert.doesNotMatch(error.message, /vault secret/)
    return true
  })
})

test('Ollama resolves the ordinary credential ref and maps results', async () => {
  let init
  const backend = createOllamaBackend({
    credentials: credentials('OLLAMA_API_KEY', 'ollama-secret'),
    async fetchImpl(url, value) {
      init = value
      assert.equal(url, 'https://ollama.com/api/web_search')
      return {
        ok: true,
        async json() {
          return {
            results: [
              { title: 'Ollama', url: 'https://ollama.com/', content: 'Cloud models are now available.' },
              { url: 'https://ollama.com/', content: 'duplicate url is dropped' },
              { title: 'Bad', url: 'not a url', content: 'skipped' },
            ],
          }
        },
      }
    },
  })
  assert.deepEqual(await backend.search({ query: 'q' }, new AbortController().signal), {
    sources: [{ url: 'https://ollama.com/', title: 'Ollama', snippet: 'Cloud models are now available.' }],
    truncated: false,
  })
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer ollama-secret')
  assert.deepEqual(JSON.parse(init.body), { query: 'q', max_results: 5 })
})

test('Ollama bounds long snippets', async () => {
  const backend = createOllamaBackend({
    credentials: credentials('OLLAMA_API_KEY', 'secret'),
    async fetchImpl() {
      return { ok: true, async json() { return { results: [{ url: 'https://example.com/', content: 'x'.repeat(2500) }] } } }
    },
  })
  const { sources } = await backend.search({ query: 'q' }, new AbortController().signal)
  assert.equal(sources[0].snippet.length, 2001)
  assert.equal(sources[0].snippet.endsWith('…'), true)
})

test('Ollama keeps a well-formed empty result set empty', async () => {
  const backend = createOllamaBackend({
    credentials: credentials('OLLAMA_API_KEY', 'secret'),
    async fetchImpl() { return { ok: true, async json() { return { results: [] } } } },
  })
  assert.deepEqual(await backend.search({ query: 'q' }, new AbortController().signal), { sources: [], truncated: false })
})

test('Ollama treats quota-exhausted empty bodies as an invalid response', async () => {
  for (const payload of [undefined, {}, { results: null }]) {
    const backend = createOllamaBackend({
      credentials: credentials('OLLAMA_API_KEY', 'secret'),
      async fetchImpl() { return { ok: true, async json() { return payload } } },
    })
    await assert.rejects(backend.search({ query: 'q' }), error => error.code === 'SEARCH_BACKEND_INVALID_RESPONSE')
  }
})

test('Ollama surfaces HTTP failures with a stable code', async () => {
  const backend = createOllamaBackend({
    credentials: credentials('OLLAMA_API_KEY', 'secret'),
    async fetchImpl() { return { ok: false, status: 429, async json() { return undefined } } },
  })
  await assert.rejects(backend.search({ query: 'q' }), error => {
    assert.equal(error.code, 'SEARCH_BACKEND_HTTP_ERROR')
    assert.doesNotMatch(error.message, /secret/)
    return true
  })
})

test('Ollama is available exactly while the credential resolves', async () => {
  let stored
  const backend = createOllamaBackend({
    credentials: { async resolve() { return stored === undefined ? undefined : { value: stored } } },
  })
  assert.equal(await backend.available(), false)
  assert.equal(backend.status.availability, 'unknown')
  await backend.refreshAvailability()
  assert.equal(backend.status.availability, 'unavailable')
  stored = 'key'
  assert.equal(await backend.available(), true)
  await backend.refreshAvailability()
  assert.equal(backend.status.availability, 'available')
})

test('Ollama credential failures expose only a stable code', async () => {
  const backend = createOllamaBackend({ credentials: { async resolve() { throw new Error('vault secret leaked') } } })
  await assert.rejects(backend.search({ query: 'q' }), error => {
    assert.equal(error.code, 'SEARCH_CREDENTIAL_MISSING')
    assert.doesNotMatch(error.message, /vault secret/)
    return true
  })
})
