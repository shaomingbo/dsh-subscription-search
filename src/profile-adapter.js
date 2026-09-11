/**
 * Profile adapter: public `dsh plugin` CLI only. No direct manifest writes,
 * no pnpm, no lifecycle scripts, no DSH process management.
 */

import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const PACKAGE_NAME = 'dsh-subscription-search'
export const SUPPORTED_DSH_VERSIONS = Object.freeze(['0.1.2-alpha.3', '0.1.2-rc.1', '0.1.5-rc.1'])
export const SUPPORTED_DSH_VERSION = SUPPORTED_DSH_VERSIONS[0]
export const DEFAULT_SOURCE = 'github:shaomingbo/dsh-subscription-search#v1.3.1'
const CLI_GUIDANCE = `Install a tested @deepseek-ai/dsh launcher (${SUPPORTED_DSH_VERSIONS.join(' or ')}) and pnpm, put its dsh executable on PATH, then check dsh --version. No manifest fallback is available.`

export function validateProfile(profile) {
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) {
    throw new Error('--profile must be a simple name (letters, digits, hyphens or underscores), not a path')
  }
  return profile
}

export function normalizeSource(source, cwd = process.cwd()) {
  if (source === DEFAULT_SOURCE) return source
  if (typeof source === 'string' && source.startsWith('link:') && source.slice(5).trim() && !/[\x00-\x1f\x7f]/.test(source)) {
    return `link:${resolve(cwd, source.slice(5))}`
  }
  throw new Error(`--source must be ${DEFAULT_SOURCE} or an explicit link:<local-path>; floating sources are not supported`)
}

function readSnapshot(path) {
  try {
    const entry = lstatSync(path)
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw Object.assign(new Error(), { code: 'UNSAFE_PROFILE_MANIFEST' })
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`Cannot read profile manifest ${path}: ${error.code ?? 'read failed'}`)
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(raw, path) {
  if (raw === null) return { installed: false, source: null, bundled: false, manifestExists: false }
  let manifest
  try { manifest = JSON.parse(raw) } catch { throw new Error(`Malformed profile manifest: ${path}`) }
  if (!object(manifest)
    || (manifest.dependencies !== undefined && !object(manifest.dependencies))
    || (manifest.dsh !== undefined && !object(manifest.dsh))
    || (manifest.dsh?.profile !== undefined && !object(manifest.dsh.profile))
    || (manifest.dsh?.profile?.bundles !== undefined && (!Array.isArray(manifest.dsh.profile.bundles) || !manifest.dsh.profile.bundles.every((entry) => typeof entry === 'string')))) {
    throw new Error(`Malformed profile manifest structure: ${path}`)
  }
  const hasDependency = Object.hasOwn(manifest.dependencies ?? {}, PACKAGE_NAME)
  const source = hasDependency ? manifest.dependencies[PACKAGE_NAME] : null
  if (hasDependency && (typeof source !== 'string' || !source)) throw new Error(`Malformed plugin dependency in ${path}`)
  const count = (manifest.dsh?.profile?.bundles ?? []).filter((entry) => entry === PACKAGE_NAME).length
  return { installed: source !== null && count === 1, source, bundled: count > 0, manifestExists: true }
}

function invoke(args, env) {
  return spawnSync('dsh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 300000 })
}

function success(result) {
  return !result.error && result.status === 0
}

function checkCli(env) {
  const version = invoke(['--version'], env)
  if (version.error?.code === 'ENOENT') throw new Error(`dsh is missing from PATH. ${CLI_GUIDANCE}`)
  if (!success(version)) throw new Error(`Cannot determine dsh CLI version. ${CLI_GUIDANCE}`)
  const actual = version.stdout.trim()
  if (!SUPPORTED_DSH_VERSIONS.includes(actual)) throw new Error(`Unsupported dsh CLI version ${JSON.stringify(actual)}; require exactly ${SUPPORTED_DSH_VERSIONS.join(' or ')}. ${CLI_GUIDANCE}`)
  if (!success(invoke(['--help'], env))) throw new Error(`dsh ${SUPPORTED_DSH_VERSION} lacks the required read-only launcher help capability. ${CLI_GUIDANCE}`)
}

export function runProfileAction({ command = 'install', profile = 'web', source = DEFAULT_SOURCE } = {}, { env = process.env, cwd = process.cwd() } = {}) {
  if (!['install', 'status', 'uninstall'].includes(command)) throw new Error(`Unknown command: ${command}`)
  validateProfile(profile)
  source = normalizeSource(source, cwd)
  const home = resolve(cwd, env.DSH_HOME || join(homedir(), '.dsh'))
  const path = join(home, 'profiles', profile, 'package.json')
  const cliEnv = { ...env, DSH_HOME: home, npm_config_ignore_scripts: 'true' }
  checkCli(cliEnv)
  for (const directory of [join(home, 'profiles'), join(home, 'profiles', profile)]) {
    try {
      const entry = lstatSync(directory)
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw Object.assign(new Error(), { code: 'UNSAFE_PROFILE_DIRECTORY' })
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot safely inspect profile directory (${error.code ?? 'read failed'}).`)
    }
  }
  const before = readSnapshot(path)
  const status = describe(before, path)
  if (command === 'status') return { ...status, profile, changed: false }
  if ((command === 'install' && status.installed && status.source === source)
    || (command === 'uninstall' && status.source === null && !status.bundled)) {
    return { ...status, profile, changed: false }
  }
  const noScripts = command === 'install' ? '--ignore-scripts' : '--config.ignore-scripts=true'
  const args = ['plugin', '--profile', profile, command === 'install' ? 'add' : 'remove', command === 'install' ? source : PACKAGE_NAME, noScripts]
  const result = invoke(args, cliEnv)
  let after
  try { after = readSnapshot(path) } catch {
    throw new Error('Cannot verify profile manifest after public dsh CLI operation. State is unknown; inspect the profile manually. No installer rollback was attempted.')
  }
  if (!success(result)) {
    const state = before === after ? 'Profile manifest is unchanged; dependency state was not verified.' : 'Profile manifest changed; rollback is NOT confirmed. Inspect the profile manually before retrying.'
    throw new Error(`Public dsh plugin ${command === 'install' ? 'add' : 'remove'} failed (exit ${result.status ?? result.error?.code ?? 'unknown'}). ${state} The public CLI owns the transaction; no installer rollback or fallback was attempted.`)
  }
  const afterStatus = describe(after, path)
  if (command === 'install' && !afterStatus.installed) {
    throw new Error(`Public dsh plugin add exited 0 but the manifest does not record ${PACKAGE_NAME} as installed. Inspect the profile manually.`)
  }
  if (command === 'uninstall' && (afterStatus.source !== null || afterStatus.bundled)) {
    throw new Error(`Public dsh plugin remove exited 0 but the manifest still references ${PACKAGE_NAME}. Inspect the profile manually.`)
  }
  return { ...afterStatus, profile, changed: before !== after }
}
