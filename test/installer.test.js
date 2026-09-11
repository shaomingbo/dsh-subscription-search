import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, run } from '../bin/install.js'
import { DEFAULT_SOURCE, PACKAGE_NAME, normalizeSource } from '../src/profile-adapter.js'

test('parseArgs defaults to official-CLI install with the fixed tag', () => {
  const options = parseArgs([])
  assert.equal(options.command, 'install')
  assert.equal(options.profile, 'web')
  assert.equal(options.source, DEFAULT_SOURCE)
  assert.throws(() => normalizeSource('github:someone/other#v1.0.0'), /floating sources/)
})

test('install/uninstall go through dsh plugin add/remove and never write the manifest themselves', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-search-cli-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const log = join(root, 'dsh-argv.log')
    const shim = join(bin, 'dsh-shim.mjs')
    writeFileSync(shim, `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
appendFileSync(process.env.DSH_ARGV_LOG, process.argv.slice(2).join(' ') + '\\n')
const [flag] = process.argv.slice(2)
if (flag === '--version') { process.stdout.write('0.1.5-rc.1\\n'); process.exit(0) }
if (flag === '--help') process.exit(0)
if (process.argv[2] === 'plugin') {
  const profile = process.argv[4]
  const action = process.argv[5]
  const spec = process.argv[6]
  const path = join(process.env.DSH_HOME, 'profiles', profile, 'package.json')
  const name = 'dsh-subscription-search'
  let pkg = { name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } }
  try { pkg = JSON.parse(readFileSync(path, 'utf8')) } catch {}
  pkg.dependencies ||= {}
  pkg.dsh ||= { profile: { bundles: [] } }
  pkg.dsh.profile ||= { bundles: [] }
  pkg.dsh.profile.bundles ||= []
  if (action === 'add') {
    pkg.dependencies[name] = spec
    if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
  } else if (action === 'remove') {
    delete pkg.dependencies[name]
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((entry) => entry !== name)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\\n')
  process.exit(0)
}
process.exit(1)
`)
    writeFileSync(join(bin, 'dsh'), `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(shim)} "$@"\n`)
    chmodSync(join(bin, 'dsh'), 0o755)
    const home = join(root, 'home')
    const env = { ...process.env, PATH: bin, DSH_HOME: home, HOME: root, DSH_ARGV_LOG: log }
    const source = `link:${root}`
    const installed = run(['install', '--source', source], { env, log() {}, cwd: root })
    assert.equal(installed.installed, true)
    assert.equal(installed.bundled, true)
    const argv = readFileSync(log, 'utf8')
    assert.match(argv, /plugin --profile web add /)
    assert.match(argv, /--ignore-scripts/)
    assert.doesNotMatch(argv, /pnpm install/)
    const removed = run(['uninstall'], { env, log() {}, cwd: root })
    assert.equal(removed.installed, false)
    assert.match(readFileSync(log, 'utf8'), /plugin --profile web remove dsh-subscription-search/)
    assert.equal(PACKAGE_NAME, 'dsh-subscription-search')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
