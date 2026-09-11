#!/usr/bin/env node
/**
 * No-argument installer. Drives the public `dsh plugin` CLI only.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SOURCE, PACKAGE_NAME, SUPPORTED_DSH_VERSIONS, normalizeSource, runProfileAction, validateProfile } from '../src/profile-adapter.js'

export function parseArgs(argv) {
  const options = { command: 'install', profile: 'web', source: DEFAULT_SOURCE }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (['install', 'status', 'uninstall'].includes(arg)) {
      if (seen.has('command')) throw new Error('Only one command may be supplied')
      seen.add('command')
      options.command = arg
    } else if (arg === '--profile' || arg === '--source') {
      if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`)
      seen.add(arg)
      const value = argv[++index]
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`)
      options[arg.slice(2)] = value
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  validateProfile(options.profile)
  options.source = normalizeSource(options.source)
  return options
}

export const HELP = `Usage: ${PACKAGE_NAME} [install|status|uninstall] [--profile <name>] [--source <source>]

No command means install. Default profile: web.
  install       Install the bundle through the public dsh plugin CLI (idempotent)
  status        Read-only manifest status; absent/uninstalled is a successful result
  uninstall     Remove the dependency and bundle (idempotent)
  --profile     Simple profile name, not a path
  --source      ${DEFAULT_SOURCE}
                or explicit link:<local-path> (relative to the invoking directory)
  -h, --help    Show help without requiring dsh or accessing a profile

Requires exactly dsh ${SUPPORTED_DSH_VERSIONS.join(' or ')} on PATH and pnpm. Check dsh --version.
All dependency operations pass --ignore-scripts. No direct manifest writes or fallback.
The public CLI owns transactions; a failure does not guarantee dependency rollback.
This installer never starts, stops or restarts DSH. After a bundle change, manually
restart the corresponding profile when convenient. For Web, hard-refresh the existing GUI.
`

export function run(argv = process.argv.slice(2), { log = console.log, ...adapterOptions } = {}) {
  const options = parseArgs(argv)
  if (options.help) { log(HELP); return }
  const result = runProfileAction(options, adapterOptions)
  log(`${PACKAGE_NAME} in profile ${options.profile}: ${result.installed ? 'installed' : result.source !== null || result.bundled ? 'incomplete' : 'not installed'}`)
  if (options.command === 'status') {
    log(`dependency: ${result.source ?? '(absent)'}; bundle entry: ${result.bundled ? 'present' : 'absent'}`)
  } else if (result.changed) {
    log('Bundle set changed. Manually restart the corresponding DSH profile when convenient; for Web, hard-refresh the existing GUI. No server lifecycle action was performed.')
  } else log('No change needed.')
  return result
}

function invokedDirectly() {
  try { return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
}
if (invokedDirectly()) {
  try { run() } catch (error) {
    console.error(`${PACKAGE_NAME}: ${error.message}`)
    process.exitCode = 1
  }
}
