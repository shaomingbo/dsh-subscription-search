import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binPath = path.join(repoRoot, 'bin', 'install.js')
const PACKAGE_NAME = 'dsh-subscription-search'

/** A throwaway DSH_HOME whose profile installs this repo offline via link:. */
function makeWorld() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'subsearch-installer-'))
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'subsearch-pnpm-cache-'))
  const profileDir = path.join(home, 'profiles', 'loop')
  fs.mkdirSync(profileDir, { recursive: true })
  return {
    home,
    profileDir,
    manifest: path.join(profileDir, 'package.json'),
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_SUBSCRIPTION_SEARCH_SOURCE: `link:${repoRoot}`,
      npm_config_cache: cache,
    },
    read: () => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')),
    text: () => fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'),
  }
}

function seed(world, pkg = { name: 'loop-profile', private: true, version: '0.0.0' }) {
  fs.mkdirSync(world.profileDir, { recursive: true })
  fs.writeFileSync(world.manifest, `${JSON.stringify(pkg, null, 2)}\n`)
}

function run(world, args, extraEnv = {}) {
  // Target the loop profile unless the case manages --profile explicitly.
  const full = args.some((arg, index) => arg === '--profile')
    ? args
    : [...args, '--profile', path.basename(world.profileDir)]
  const result = spawnSync(process.execPath, [binPath, ...full], {
    env: { ...world.env, ...extraEnv },
    encoding: 'utf8',
  })
  result.output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return result
}

test('the full install → status → uninstall lifecycle works from no arguments at all', () => {
  const world = makeWorld()
  seed(world)

  // No arguments equals plain installation.
  let result = run(world, [])
  assert.equal(result.status, 0, result.output)
  const manifest = world.read()
  assert.equal(manifest.dependencies[PACKAGE_NAME], `link:${repoRoot}`)
  assert.ok(manifest.dsh.profile.bundles.includes(PACKAGE_NAME))
  assert.ok(fs.existsSync(path.join(world.profileDir, 'node_modules', PACKAGE_NAME, 'package.json')))

  result = run(world, ['status'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /is installed/)

  result = run(world, ['uninstall'])
  assert.equal(result.status, 0, result.output)
  const after = world.read()
  assert.equal(after.dependencies?.[PACKAGE_NAME], undefined)
  assert.ok(!after.dsh.profile.bundles.includes(PACKAGE_NAME))
  assert.ok(!fs.existsSync(path.join(world.profileDir, 'node_modules', PACKAGE_NAME)))

  result = run(world, ['status'])
  assert.equal(result.status, 1)
  assert.match(result.output, /not installed/)

  // Uninstall is idempotent.
  result = run(world, ['uninstall'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /not installed in/)

  // And the cycle can be replayed.
  result = run(world, ['install'])
  assert.equal(result.status, 0, result.output)
  assert.match(run(world, ['status']).output, /is installed/)
})

test('repeat installs leave the manifest byte-identical', () => {
  const world = makeWorld()
  seed(world)
  assert.equal(run(world, ['install']).status, 0)
  const once = world.text()
  assert.equal(run(world, ['install']).status, 0)
  assert.equal(world.text(), once)
})

test('status distinguishes a clean absence from a partial state', () => {
  const world = makeWorld()
  seed(world)
  let result = run(world, ['status'])
  assert.equal(result.status, 1)
  assert.match(result.output, /not installed/)

  assert.equal(run(world, ['install']).status, 0)

  // Hand-remove only the bundle entry: dependency + copy remain.
  const manifest = world.read()
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== PACKAGE_NAME)
  fs.writeFileSync(world.manifest, `${JSON.stringify(manifest, null, 2)}\n`)

  result = run(world, ['status'])
  assert.equal(result.status, 1)
  assert.match(result.output, /partially installed/)
})

test('a malformed manifest fails every command without being rewritten', () => {
  const world = makeWorld()
  fs.mkdirSync(world.profileDir, { recursive: true })
  fs.writeFileSync(world.manifest, '{broken json')
  for (const args of [['install'], ['status'], ['uninstall']]) {
    const result = run(world, args)
    assert.notEqual(result.status, 0, `${args.join(' ')} should fail`)
    assert.match(result.output, /malformed profile manifest/)
    assert.equal(fs.readFileSync(world.manifest, 'utf8'), '{broken json')
  }
})

test('argument errors never touch the manifest', () => {
  const world = makeWorld()
  seed(world)
  const before = world.text()
  for (const args of [
    ['wat'],
    ['--bogus'],
    ['install', 'uninstall'],
    ['--profile'],
  ]) {
    const result = run(world, args)
    assert.notEqual(result.status, 0, `${args.join(' ')} should fail`)
    assert.equal(world.text(), before, `${args.join(' ')} must not rewrite the manifest`)
  }
})

test('--source records exactly the spec it was given (offline via a dummy package)', () => {
  const world = makeWorld()
  seed(world)
  const dummy = fs.mkdtempSync(path.join(os.tmpdir(), 'subsearch-dummy-pkg-'))
  fs.writeFileSync(path.join(dummy, 'package.json'), JSON.stringify({ name: 'dummy-bundle', version: '1.2.3' }))
  const result = run(world, ['install', '--source', `link:${dummy}`])
  assert.equal(result.status, 0, result.output)
  assert.equal(world.read().dependencies[PACKAGE_NAME], `link:${dummy}`)
})

test('dependency toolchain failures roll the manifest back on install and uninstall', () => {
  const world = makeWorld()
  seed(world)

  // Shim both toolchain entry points with deterministic failures so neither
  // the direct pnpm call nor the corepack fallback can succeed.
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'subsearch-shim-'))
  for (const name of ['pnpm', 'corepack']) {
    const script = path.join(shim, name)
    fs.writeFileSync(script, '#!/bin/sh\nexit 3\n')
    fs.chmodSync(script, 0o755)
  }
  const brokenPath = `${shim}:${process.env.PATH}`

  let result = run(world, [], { PATH: brokenPath })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /failed with exit code 3/)
  assert.equal(JSON.parse(world.text()).dependencies?.[PACKAGE_NAME], undefined, 'install must restore the manifest')

  // With a working toolchain the install lands; then uninstall hits the same rollback path.
  assert.equal(run(world, []).status, 0)
  result = run(world, ['uninstall'], { PATH: brokenPath })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /failed with exit code 3/)
  assert.equal(world.read().dependencies[PACKAGE_NAME], `link:${repoRoot}`, 'uninstall must restore the manifest')
})

test('install blocks while superseded bridge bundles remain in the manifest', () => {
  const world = makeWorld()
  seed(world, {
    name: 'loop-profile', private: true,
    dependencies: { 'dsh-codex-auth-bridge': 'github:o/bridge#v1.0.0' },
    dsh: { profile: { bundles: ['dsh-codex-auth-bridge'] } },
  })
  const before = world.text()

  const result = run(world, ['install'])
  assert.notEqual(result.status, 0, result.output)
  assert.match(result.output, /legacy state detected/i)
  assert.match(result.output, /dsh-codex-auth-bridge/)
  assert.match(result.output, /manual migration/i)
  assert.equal(world.text(), before, 'the manifest must stay untouched while legacy state blocks the install')
})

test('install blocks while bridge routes remain in settings.yaml', () => {
  const world = makeWorld()
  seed(world)
  const settingsPath = path.join(world.home, 'settings.yaml')
  const settings = `llm:\n  pi:\n  providers:\n    grok-build:\n      ref: GROK_BRIDGE\n    openai-codex:\n      ref: CODEX_BRIDGE\n`
  fs.writeFileSync(settingsPath, settings)
  const before = fs.readFileSync(settingsPath, 'utf8')

  const result = run(world, ['install'])
  assert.notEqual(result.status, 0, result.output)
  assert.match(result.output, /legacy state detected/i)
  assert.match(result.output, /grok-build/)
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), before, 'settings.yaml must never be mutated by the installer')
})

test('install blocks while workspace override symlinks exist', () => {
  const world = makeWorld()
  seed(world)
  const overrideDir = path.join(world.profileDir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-models')
  fs.mkdirSync(path.dirname(overrideDir), { recursive: true })
  fs.symlinkSync(repoRoot, overrideDir, 'dir')

  const result = run(world, ['install'])
  assert.notEqual(result.status, 0, result.output)
  assert.match(result.output, /legacy state detected/i)
  assert.match(result.output, /dsh-client-ui-settings-models/)
  assert.ok(fs.lstatSync(overrideDir).isSymbolicLink(), 'the override symlink must stay untouched')
})

test('status reports legacy state and install succeeds once the migration is done', () => {
  const world = makeWorld()
  seed(world, {
    name: 'loop-profile', private: true,
    dsh: { profile: { bundles: ['dsh-grok-build-auth-bridge'] } },
  })

  let result = run(world, ['status'])
  assert.match(result.output, /legacy state detected/i)
  assert.match(result.output, /dsh-grok-build-auth-bridge/)

  // Manual migration: the owner removes the bridge entry by hand.
  const manifest = world.read()
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-grok-build-auth-bridge')
  fs.writeFileSync(world.manifest, `${JSON.stringify(manifest, null, 2)}\n`)

  assert.equal(run(world, ['install']).status, 0)
  assert.doesNotMatch(run(world, ['status']).output, /legacy state detected/i)
})

test('installer runs never read or write the oauth credential store', () => {
  const world = makeWorld()
  seed(world)
  const oauthStore = path.join(world.home, '.oauth.json')
  const fakeCredentials = '{"version":1,"providers":{"chatgpt":{"accessToken":"<REDACTED>","refreshToken":"<REDACTED>"}}}'
  fs.writeFileSync(oauthStore, fakeCredentials)
  const credentialsSeam = path.join(world.home, 'credentials.yaml')
  fs.writeFileSync(credentialsSeam, 'version: 1\nrefs:\n  CHATGPT_TOKEN: from-store\n')

  assert.equal(run(world, ['install']).status, 0, run(world, ['status']).output)
  assert.equal(run(world, ['uninstall']).status, 0)
  assert.equal(fs.readFileSync(oauthStore, 'utf8'), fakeCredentials, 'the oauth store must survive installer runs byte-identically')
  assert.equal(fs.readFileSync(credentialsSeam, 'utf8'), 'version: 1\nrefs:\n  CHATGPT_TOKEN: from-store\n', 'the credentials seam must survive installer runs byte-identically')
  assert.doesNotMatch(run(world, ['status']).output, /<REDACTED>/, 'no credential value may appear in installer output')
})
