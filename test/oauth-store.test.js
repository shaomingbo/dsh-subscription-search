import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuthCredentialFileStore, parseOAuthDocument } from '../lib/oauth-store.js'

test('parseOAuthDocument accepts a valid document', () => {
  const credentials = parseOAuthDocument(JSON.stringify({
    version: 1,
    credentials: {
      xai: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: Date.now() + 60000,
      },
    },
  }))
  assert.equal(credentials.get('xai').access, 'a')
})

test('parseOAuthDocument rejects invalid JSON without leaking content', () => {
  assert.throws(() => parseOAuthDocument('{broken'), /not valid JSON/)
})

test('parseOAuthDocument rejects an unsupported version', () => {
  assert.throws(() => parseOAuthDocument(JSON.stringify({ version: 99, credentials: {} })), /unsupported version/)
})

test('store persists credentials with owner-only mode and publishes changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sub-search-'))
  try {
    const filename = join(dir, '.oauth.json')
    const changed = []
    const store = new OAuthCredentialFileStore({
      filename,
      onChanged: providerId => changed.push(providerId),
      onError: () => {},
    })
    await store.init()
    await store.modify(map => {
      map.set('xai', { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 60000 })
    })
    assert.equal(store.has('xai'), true)
    assert.deepEqual(changed, ['xai'])
    const text = await readFile(filename, 'utf8')
    assert.equal(JSON.parse(text).credentials.xai.access, 'a')
    const mode = (await stat(filename)).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store keeps the last good snapshot after an invalid external edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sub-search-'))
  try {
    const filename = join(dir, '.oauth.json')
    const errors = []
    const store = new OAuthCredentialFileStore({
      filename,
      onChanged: () => {},
      onError: error => errors.push(error),
    })
    await store.init()
    await store.modify(map => {
      map.set('xai', { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 60000 })
    })
    await writeFile(filename, '{', { mode: 0o600 })
    await store.reload()
    assert.ok(errors.length > 0)
    assert.equal(store.has('xai'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store queues mutations serially', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sub-search-'))
  try {
    const filename = join(dir, '.oauth.json')
    const store = new OAuthCredentialFileStore({ filename, onChanged: () => {}, onError: () => {} })
    await store.init()
    const writes = []
    for (const provider of ['openai-codex', 'xai']) {
      writes.push(store.modify(map => {
        map.set(provider, { type: 'oauth', access: provider, refresh: 'r', expires: Date.now() + 60000 })
      }))
    }
    await Promise.all(writes)
    const text = JSON.parse(await readFile(filename, 'utf8'))
    assert.ok(text.credentials['openai-codex'])
    assert.ok(text.credentials.xai)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
