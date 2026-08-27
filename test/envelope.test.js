import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Imported through a cache-safe dynamic specifier so every boot() below sees
// one shared module instance while applying against a fresh DSH_HOME each time.
const { apply, envelopeCode } = await import('../lib/index.js')

/**
 * Boots the plugin exactly like the host would: a fake context whose rpc
 * handle captures the channel function, plus a throwaway DSH_HOME so the
 * OAuth store never touches real credentials.
 */
async function boot() {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'subsearch-envelope-'))
  let handler
  let dispose
  const noop = () => {}
  const ctx = {
    credentials: {},
    settings: { get: () => undefined, update: async () => {} },
    logger: { warn: noop },
    web: { registerSearchProvider: noop },
    interval: noop,
    on: (event, fn) => {
      if (event === 'dispose') dispose = fn
    },
    connection: { rpc: { handle: (_channel, fn) => { handler = fn } } },
  }
  apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 0)) // let route provisioning settle
  return {
    call: (endpoint, payload, signal) => handler(endpoint, payload, signal),
    dispose: () => dispose(),
  }
}

/** The failure surface this plugin may emit under the published rpcResultSchema. */
function assertEnvelopeLegal(result) {
  assert.equal(result.ok, false)
  assert.equal(typeof result.error.message, 'string')
  assert.ok(result.error.code === 'cancelled' || result.error.code === 'internal')
  assert.deepEqual(result.error.details, {})
}

test('envelopeCode folds every namespace into the schema-legal whitelist', () => {
  const mappings = [
    // Already legal codes pass through unchanged.
    ['cancelled', 'cancelled'],
    ['internal', 'internal'],
    // User-initiated cancellation keeps a precise legal code.
    ['PI_AI_AUTH_ABORTED', 'cancelled'],
    // Every remaining private auth code collapses to internal.
    ['PI_AI_AUTH_PROVIDER_UNKNOWN', 'internal'],
    ['PI_AI_AUTH_RESOLUTION_FAILED', 'internal'],
    ['PI_AI_AUTH_LOGIN_IN_PROGRESS', 'internal'],
    ['PI_AI_AUTH_LOGIN_NOT_FOUND', 'internal'],
    ['PI_AI_AUTH_LOGIN_UNSUPPORTED', 'internal'],
    ['PI_AI_AUTH_LOGIN_FAILED', 'internal'],
    // Search-chain and usage namespaces fold just as safely if they ever leak.
    ['WEB_ABORTED', 'internal'],
    ['WEB_PROVIDER_TIMEOUT', 'internal'],
    ['WEB_PROVIDER_CREDENTIAL_MISSING', 'internal'],
    ['WEB_PROVIDER_ERROR', 'internal'],
    ['USAGE_UNAVAILABLE', 'internal'],
    ['USAGE_UNAUTHORIZED', 'internal'],
    ['USAGE_TIMEOUT', 'internal'],
    // Anything non-string falls back to the generic code.
    [undefined, 'internal'],
    [42, 'internal'],
    [{}, 'internal'],
  ]
  for (const [input, expected] of mappings) assert.equal(envelopeCode(input), expected)
})

test('start-login failure keeps a legal envelope and preserves the original code prefix', async () => {
  const { call } = await boot()
  const result = await call('start-login', { provider: 'bogus' }, undefined)
  assertEnvelopeLegal(result)
  assert.equal(result.error.code, 'internal')
  assert.match(result.error.message, /\[PI_AI_AUTH_PROVIDER_UNKNOWN\]/)
})

test('login-status on a stale loginId stays schema-legal with its original code visible', async () => {
  const { call } = await boot()
  const result = await call('login-status', { loginId: 'does-not-exist' }, undefined)
  assertEnvelopeLegal(result)
  assert.equal(result.error.code, 'internal')
  assert.match(result.error.message, /\[PI_AI_AUTH_LOGIN_NOT_FOUND\]/)
})

test('cancel-login on a stale loginId stays schema-legal too', async () => {
  const { call } = await boot()
  const result = await call('cancel-login', { loginId: 'does-not-exist' }, undefined)
  assertEnvelopeLegal(result)
  assert.equal(result.error.code, 'internal')
  assert.match(result.error.message, /\[PI_AI_AUTH_LOGIN_NOT_FOUND\]/)
})

test('an already-aborted login surfaces as the cancelled envelope code', async () => {
  const instance = await boot()
  instance.dispose()
  // startLogin asserts open before validating the provider id, so this hits
  // PI_AI_AUTH_ABORTED — the one private code that maps to "cancelled".
  const result = await instance.call('start-login', { provider: 'openai-codex' }, undefined)
  assertEnvelopeLegal(result)
  assert.equal(result.error.code, 'cancelled')
  assert.match(result.error.message, /\[PI_AI_AUTH_ABORTED\]/)
})

test('payload rejections need no artificial code prefix', async () => {
  const { call } = await boot()
  const result = await call('logout', null, undefined)
  assertEnvelopeLegal(result)
  assert.equal(result.error.code, 'internal')
  assert.doesNotMatch(result.error.message, /^\[/)
})

test('unknown endpoints keep the plain generic envelope', async () => {
  const { call } = await boot()
  const result = await call('no-such-endpoint', {}, undefined)
  assertEnvelopeLegal(result)
  assert.equal(result.error.code, 'internal')
  assert.doesNotMatch(result.error.message, /^\[/)
})

test('success paths are untouched by envelope normalization', async () => {
  const { call } = await boot()
  const result = await call('providers', {}, undefined)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.providers.map(provider => provider.provider), ['openai-codex', 'xai'])
  for (const provider of result.value.providers) {
    assert.equal(typeof provider.displayName, 'string')
    assert.equal(provider.configured, false)
  }
})
