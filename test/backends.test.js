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

test('status reports configuration through describe without touching the value', async () => {
  for (const [create, ref] of [[createExaBackend, 'EXA_API_KEY'], [createDeepSeekBackend, 'DEEPSEEK_API_KEY'], [createOllamaBackend, 'OLLAMA_API_KEY']]) {
    const probed = []
    const backend = create({
      credentials: {
        async describe(queried) { probed.push(queried); return { configured: true, source: 'file' } },
        async resolve() { throw new Error('resolve must not run for a status probe') },
      },
    })
    assert.deepEqual(await backend.status(), { availability: 'available' })
    assert.equal(await backend.available(), true)
    assert.deepEqual(probed, [ref, ref])
  }
})

test('status reads an unconfigured ref as unavailable and gates the leg', async () => {
  const backend = createExaBackend({ credentials: { async describe() { return { configured: false } } } })
  assert.deepEqual(await backend.status(), { availability: 'unavailable' })
  assert.equal(await backend.available(), false)
})

test('status claims nothing when the host exposes no describe seam', async () => {
  const backend = createExaBackend({ credentials: {} })
  assert.equal((await backend.status()).availability, undefined)
  assert.equal(await backend.available(), true)
})

test('status of a throwing describe stays a non-event', async () => {
  const backend = createExaBackend({ credentials: { async describe() { throw new Error('vault secret leaked') } } })
  assert.equal((await backend.status()).availability, undefined)
  assert.equal(await backend.available(), true)
})

test('Ollama gates the leg on the configured describe seam', async () => {
  const backend = createOllamaBackend({ credentials: { async describe() { return { configured: false } } } })
  assert.deepEqual(await backend.status(), { availability: 'unavailable' })
  assert.equal(await backend.available(), false)
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

test('Ollama credential failures expose only a stable code', async () => {
  const backend = createOllamaBackend({ credentials: { async resolve() { throw new Error('vault secret leaked') } } })
  await assert.rejects(backend.search({ query: 'q' }), error => {
    assert.equal(error.code, 'SEARCH_CREDENTIAL_MISSING')
    assert.doesNotMatch(error.message, /vault secret/)
    return true
  })
})
