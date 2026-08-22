import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCredentialSynchronizer } from '../lib/credential-sync.js'

test('request synchronization propagates OAuth refresh failures', async () => {
  const warnings = []
  const synchronizer = createCredentialSynchronizer({
    auth: {
      configured: () => true,
      resolveOAuth: async () => { throw new Error('refresh failed') },
    },
    credentials: { resolve: async () => undefined, set: async () => {} },
    logger: { warn: (...args) => warnings.push(args), info: () => {} },
  })

  await assert.rejects(synchronizer.sync('xai', 'request'), /refresh failed/)
  assert.deepEqual(warnings, [])
})

test('background synchronization logs failures without rejecting', async () => {
  const warnings = []
  const synchronizer = createCredentialSynchronizer({
    auth: {
      configured: () => true,
      resolveOAuth: async () => { throw new Error('refresh failed') },
    },
    credentials: { resolve: async () => undefined, set: async () => {} },
    logger: { warn: (...args) => warnings.push(args), info: () => {} },
  })

  await synchronizer.background('xai', 'timer')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /sync failed/)
})

test('different providers synchronize independently', async () => {
  const started = []
  const releases = new Map()
  const synchronizer = createCredentialSynchronizer({
    auth: {
      configured: () => true,
      resolveOAuth: provider => new Promise(resolve => {
        started.push(provider)
        releases.set(provider, resolve)
      }),
    },
    credentials: { resolve: async () => undefined, set: async () => {} },
    logger: { warn: () => {}, info: () => {} },
  })

  const openai = synchronizer.sync('openai-codex', 'timer')
  const xai = synchronizer.sync('xai', 'timer')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started.sort(), ['openai-codex', 'xai'])
  releases.get('openai-codex')({ apiKey: 'openai-token' })
  releases.get('xai')({ apiKey: 'xai-token' })
  await Promise.all([openai, xai])
})
