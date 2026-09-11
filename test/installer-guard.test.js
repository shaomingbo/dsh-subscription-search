import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../bin/install.js', import.meta.url))

test('install fails closed on an unverified CLI and does not write the profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-search-guard-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'dsh'), '#!/bin/sh\necho 9.9.9\n')
    chmodSync(join(bin, 'dsh'), 0o755)
    const home = join(root, 'home')
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    const manifest = join(profile, 'package.json')
    writeFileSync(manifest, `${JSON.stringify({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`)
    const result = spawnSync(process.execPath, [installer, 'install'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin, DSH_HOME: home, HOME: root },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Unsupported dsh CLI version/)
    assert.match(result.stderr, /0\.1\.5-rc\.1/)
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).dependencies['dsh-subscription-search'], undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
