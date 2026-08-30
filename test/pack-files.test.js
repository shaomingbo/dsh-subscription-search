import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const REQUIRED = [
  'bin/install.js', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/search-chain.js',
  'lib/chain-search.js', 'README.md', 'README.zh.md', 'SPEC.md', 'CONTEXT.md', 'LICENSE',
]
const FORBIDDEN = ['lib/auth-runtime.js', 'lib/oauth-store.js', 'lib/credential-sync.js', 'lib/usage.js']

test('package metadata is the search-only 1.1.0 identity with only settings dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-subscription-search')
  assert.equal(pkg.version, '1.1.0')
  assert.deepEqual(pkg.dependencies, {
    '@deepseek-ai/dsh-settings': '0.1.1-rc.2',
    '@deepseek-ai/schemastery': '3.18.1',
  })
  assert.equal(pkg.exports['./search-chain'], './lib/search-chain.js')
})

test('npm pack contains every runtime/spec file and no legacy ownership module', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const payload = JSON.parse(packed.stdout)
  const names = new Set((payload[0]?.files ?? []).map(file => file.path))
  for (const file of REQUIRED) assert.ok(names.has(file), `npm pack omits ${file}`)
  for (const file of FORBIDDEN) assert.equal(names.has(file), false, `npm pack retains ${file}`)
})
