import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

const REQUIRED_LIB = [
  'lib/index.js',
  'lib/client.js',
  'lib/auth-runtime.js',
  'lib/chain-search.js',
  'lib/oauth-store.js',
]

test('package files field ships every host module the runtime imports', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const files = pkg.files
  const shipsLibDir = files.includes('lib') || files.includes('lib/')
  for (const file of REQUIRED_LIB) {
    assert.ok(
      shipsLibDir || files.includes(file),
      `package.json files omits ${file}; pnpm/npm git installs will drop it`,
    )
  }
})

test('npm pack includes every host module the runtime imports', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const payload = JSON.parse(packed.stdout)
  const entry = Array.isArray(payload) ? payload[0] : payload
  const names = new Set((entry.files ?? []).map(file => file.path))
  for (const file of REQUIRED_LIB) {
    assert.ok(names.has(file), `npm pack omits ${file}`)
  }
})
