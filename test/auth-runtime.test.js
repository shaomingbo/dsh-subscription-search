import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SubscriptionAuthRuntime } from '../lib/auth-runtime.js'
import { SubscriptionChainSearchProvider } from '../lib/chain-search.js'

test('providers() lists both subscriptions in stable order without secrets', () => {
  const runtime = new SubscriptionAuthRuntime({ filename: '/tmp/nonexistent-oauth.json' })
  const providers = runtime.providers()
  assert.deepEqual(providers.map(p => p.provider), ['openai-codex', 'xai'])
  for (const provider of providers) {
    assert.equal(typeof provider.displayName, 'string')
    assert.equal(typeof provider.loginLabel, 'string')
    assert.equal(provider.configured, false)
  }
})

test('configured() rejects an unsupported provider id', () => {
  const runtime = new SubscriptionAuthRuntime({ filename: '/tmp/nonexistent-oauth.json' })
  assert.throws(() => runtime.configured('unknown'), /not supported/)
})

test('resolveOAuth returns undefined before login', async () => {
  const runtime = new SubscriptionAuthRuntime({ filename: '/tmp/nonexistent-oauth.json' })
  assert.equal(await runtime.resolveOAuth('xai'), undefined)
})

test('chain provider skips unconfigured legs and reports exhaustion safely', async () => {
  const auth = {
    resolveOAuth: async () => undefined,
  }
  const credentials = {
    resolve: async ref => ref === 'DEEPSEEK_API_KEY' ? { value: 'k' } : undefined,
  }
  const provider = new SubscriptionChainSearchProvider({ auth, credentials })
  // No ChatGPT/Grok OAuth, no EXA key → only DeepSeek is reachable, but the
  // DeepSeek fetch fails against a dead endpoint; exhaustion carries safe ids.
  await assert.rejects(
    provider.search({ query: 'test' }, new AbortController().signal),
    error => error.code === 'WEB_SEARCH_CHAIN_EXHAUSTED' && /subscription-search:error/.test(error.message),
  )
})

test('chain provider aborts immediately on caller cancellation', async () => {
  const auth = { resolveOAuth: async () => undefined }
  const provider = new SubscriptionChainSearchProvider({ auth, credentials: { resolve: async () => undefined } })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    provider.search({ query: 'test' }, controller.signal),
    error => error.code === 'WEB_ABORTED',
  )
})

test('verificationUri rejects an untrusted origin', () => {
  const runtime = new SubscriptionAuthRuntime({ filename: '/tmp/nonexistent-oauth.json' })
  assert.throws(() => runtime.verificationUri('xai', 'https://evil.example/device'), /untrusted verification URL/)
  assert.equal(runtime.verificationUri('xai', 'https://accounts.x.ai/device?code=x'), 'https://accounts.x.ai/device?code=x')
  assert.equal(runtime.verificationUri('openai-codex', 'https://auth.openai.com/device'), 'https://auth.openai.com/device')
})

test('configured() answers from the local store without any network access', async () => {
  // Poison the network surface: if the configured probe reached for the web,
  // these stubs would make it blow up instead of answering from the store.
  const networkGuards = [
    mock.method(globalThis, 'fetch', () => { throw new Error('network is forbidden in this test') }),
  ]
  try {
    const runtime = new SubscriptionAuthRuntime({ filename: '/tmp/nonexistent-oauth.json' })
    assert.equal(runtime.configured('xai'), false)
    assert.equal(runtime.configured('openai-codex'), false)
    const providers = runtime.providers()
    assert.equal(providers.every(provider => provider.configured === false), true)
  } finally {
    for (const guard of networkGuards) guard.mock.restore()
  }
})
