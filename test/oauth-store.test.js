import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai'
import { OAuthCredentialFileStore, parseOAuthDocument } from '../lib/oauth-store.js'

function oauthCredential(access, expires = Date.now() + 60000) {
  return { type: 'oauth', access, refresh: 'r', expires }
}

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
    const saved = await store.modify('xai', async current => {
      assert.equal(current, undefined)
      return oauthCredential('a')
    })
    assert.equal(saved.access, 'a')
    assert.equal(store.has('xai'), true)
    assert.deepEqual(await store.list(), [{ providerId: 'xai', type: 'oauth' }])
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
    await store.modify('xai', async () => oauthCredential('a'))
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
      writes.push(store.modify(provider, async () => oauthCredential(provider)))
    }
    await Promise.all(writes)
    const text = JSON.parse(await readFile(filename, 'utf8'))
    assert.ok(text.credentials['openai-codex'])
    assert.ok(text.credentials.xai)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store implements the pi-ai refresh contract and persists refreshed OAuth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sub-search-'))
  try {
    const filename = join(dir, '.oauth.json')
    await writeFile(filename, JSON.stringify({
      version: 1,
      credentials: { xai: oauthCredential('expired', Date.now() - 1000) },
    }), { mode: 0o600 })
    const store = new OAuthCredentialFileStore({ filename, onChanged: () => {}, onError: () => {} })
    await store.init()
    const models = createModels({ credentials: store })
    let refreshes = 0
    models.setProvider({
      id: 'xai',
      name: 'xAI',
      auth: {
        oauth: {
          refresh: async current => {
            refreshes += 1
            assert.equal(current.access, 'expired')
            return oauthCredential('fresh')
          },
          toAuth: async current => ({ apiKey: current.access }),
        },
      },
      getModels: () => [],
    })

    const resolved = await models.getAuth('xai')

    assert.equal(resolved.auth.apiKey, 'fresh')
    assert.equal(refreshes, 1)
    const text = JSON.parse(await readFile(filename, 'utf8'))
    assert.equal(text.credentials.xai.access, 'fresh')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store delete removes and publishes an OAuth credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sub-search-'))
  try {
    const filename = join(dir, '.oauth.json')
    const changed = []
    const store = new OAuthCredentialFileStore({
      filename,
      onChanged: provider => changed.push(provider),
      onError: () => {},
    })
    await store.init()
    await store.modify('xai', async () => oauthCredential('a'))
    await store.delete('xai')

    assert.equal(await store.read('xai'), undefined)
    assert.deepEqual(changed, ['xai', 'xai'])
    const text = JSON.parse(await readFile(filename, 'utf8'))
    assert.equal(text.credentials.xai, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
