import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekBackend, createExaBackend } from '../lib/chain-search.js'

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
