import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = path.join(root, 'bin', 'install.js')
const NAME = 'dsh-subscription-search'

function world(pkg = { name: 'test-profile', private: true, version: '0.0.0' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'search-installer-'))
  const profile = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profile, { recursive: true })
  const manifest = path.join(profile, 'package.json')
  fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
  const env = { ...process.env, DSH_HOME: home, DSH_SUBSCRIPTION_SEARCH_SOURCE: `link:${root}` }
  return { home, profile, manifest, env, read: () => JSON.parse(fs.readFileSync(manifest, 'utf8')), text: () => fs.readFileSync(manifest, 'utf8') }
}

function run(w, args = [], extra = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], { env: { ...w.env, ...extra }, encoding: 'utf8' })
  result.output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return result
}

test('no-argument install, repeat install, status, uninstall, and repeat uninstall are idempotent', () => {
  const w = world()
  let result = run(w)
  assert.equal(result.status, 0, result.output)
  assert.equal(w.read().dependencies[NAME], `link:${root}`)
  assert.deepEqual(w.read().dsh.profile.bundles, [NAME])
  const once = w.text()
  assert.equal(run(w).status, 0)
  assert.equal(w.text(), once)
  assert.equal(run(w, ['status']).status, 0)
  assert.equal(run(w, ['uninstall']).status, 0)
  assert.equal(w.read().dependencies?.[NAME], undefined)
  assert.equal(run(w, ['uninstall']).status, 0)
  assert.equal(run(w, ['status']).status, 1)
})

test('installer only changes its own dependency and bundle entry and performs no legacy cleanup', () => {
  const packages = fs.mkdtempSync(path.join(os.tmpdir(), 'search-preserved-deps-'))
  const other = path.join(packages, 'other')
  const bridge = path.join(packages, 'bridge')
  fs.mkdirSync(other); fs.mkdirSync(bridge)
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }))
  fs.writeFileSync(path.join(bridge, 'package.json'), JSON.stringify({ name: 'dsh-codex-auth-bridge', version: '2.0.0' }))
  const original = {
    name: 'test-profile', private: true,
    dependencies: { other: `link:${other}`, 'dsh-codex-auth-bridge': `link:${bridge}` },
    dsh: { profile: { bundles: ['other', 'dsh-codex-auth-bridge'] }, untouched: { yes: true } },
  }
  const w = world(original)
  const settings = path.join(w.home, 'settings.yaml')
  fs.writeFileSync(settings, 'providers:\n  openai-codex:\n    keep: true\n')
  assert.equal(run(w).status, 0)
  const after = w.read()
  assert.equal(after.dependencies.other, `link:${other}`)
  assert.equal(after.dependencies['dsh-codex-auth-bridge'], `link:${bridge}`)
  assert.deepEqual(after.dsh.profile.bundles, ['other', 'dsh-codex-auth-bridge', NAME])
  assert.deepEqual(after.dsh.untouched, { yes: true })
  assert.equal(fs.readFileSync(settings, 'utf8'), 'providers:\n  openai-codex:\n    keep: true\n')
})

test('malformed manifests and argument errors fail without rewriting', () => {
  const w = world()
  const before = w.text()
  for (const args of [['wat'], ['--bogus'], ['install', 'status'], ['--profile']]) {
    const result = run(w, args)
    assert.notEqual(result.status, 0)
    assert.equal(w.text(), before)
  }
  fs.writeFileSync(w.manifest, '{bad json')
  for (const command of ['install', 'status', 'uninstall']) {
    const result = run(w, [command])
    assert.notEqual(result.status, 0)
    assert.match(result.output, /malformed profile manifest/)
    assert.equal(fs.readFileSync(w.manifest, 'utf8'), '{bad json')
  }
})

test('dependency-install failures restore install and uninstall manifests', () => {
  const w = world()
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'search-installer-shim-'))
  for (const name of ['pnpm', 'corepack']) {
    fs.writeFileSync(path.join(shim, name), '#!/bin/sh\nexit 3\n')
    fs.chmodSync(path.join(shim, name), 0o755)
  }
  const PATH = `${shim}:${process.env.PATH}`
  const before = w.text()
  let result = run(w, [], { PATH })
  assert.notEqual(result.status, 0)
  assert.equal(w.text(), before)
  assert.equal(run(w).status, 0)
  const installed = w.text()
  result = run(w, ['uninstall'], { PATH })
  assert.notEqual(result.status, 0)
  assert.equal(w.text(), installed)
})

test('fixed release source, --source override, profile flag, and help contract are explicit', () => {
  const w = world()
  const help = run(w, ['--help'], { DSH_SUBSCRIPTION_SEARCH_SOURCE: '' })
  assert.equal(help.status, 0)
  assert.match(help.output, /github:shaomingbo\/dsh-subscription-search#v1\.2\.0/)
  assert.match(help.output, /--profile/)
  assert.match(help.output, /--source/)

  const dummy = fs.mkdtempSync(path.join(os.tmpdir(), 'search-dummy-'))
  fs.writeFileSync(path.join(dummy, 'package.json'), JSON.stringify({ name: 'dummy', version: '1.0.0' }))
  const result = run(w, ['install', '--source', `link:${dummy}`, '--profile', 'web'])
  assert.equal(result.status, 0, result.output)
  assert.equal(w.read().dependencies[NAME], `link:${dummy}`)
})

test('installer never reads, writes, or prints credential stores', () => {
  const w = world()
  const oauth = path.join(w.home, '.oauth.json')
  const credentials = path.join(w.home, 'credentials.yaml')
  fs.writeFileSync(oauth, '{"token":"SENTINEL_OAUTH_SECRET"}')
  fs.writeFileSync(credentials, 'EXA_API_KEY: SENTINEL_API_SECRET\n')
  const result = run(w)
  assert.equal(result.status, 0, result.output)
  assert.equal(fs.readFileSync(oauth, 'utf8'), '{"token":"SENTINEL_OAUTH_SECRET"}')
  assert.equal(fs.readFileSync(credentials, 'utf8'), 'EXA_API_KEY: SENTINEL_API_SECRET\n')
  assert.doesNotMatch(result.output, /SENTINEL_/)
})
