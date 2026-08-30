#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-subscription-search'
const DEFAULT_SOURCE = 'github:shaomingbo/dsh-subscription-search#v1.1.0'
const COMMANDS = ['install', 'status', 'uninstall']

function parseArgs(argv) {
  const result = { command: undefined, profile: 'web', source: process.env.DSH_SUBSCRIPTION_SEARCH_SOURCE || DEFAULT_SOURCE }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') result.profile = argv[++index]
    else if (arg === '--source') result.source = argv[++index]
    else if (arg === '--help' || arg === '-h') result.help = true
    else if (COMMANDS.includes(arg)) {
      if (result.command !== undefined) throw new Error(`unexpected extra command: ${arg}`)
      result.command = arg
    } else throw new Error(`unknown argument or command: ${arg}`)
  }
  if (!result.profile || !result.source) throw new Error('--profile and --source require values')
  result.command ??= 'install'
  return result
}

function printHelp() {
  console.log(`Usage: ${PACKAGE_NAME} [install|status|uninstall] [--profile web] [--source ${DEFAULT_SOURCE}]\n\n`
    + 'Commands:\n'
    + '  install     Install into a DSH profile and add its Cordis bundle (default).\n'
    + '  status      Report whether the target profile has this plugin installed.\n'
    + '  uninstall   Remove this dependency reference and Cordis bundle entry.\n\n'
    + 'Flags:\n'
    + '  --profile   Target profile under $DSH_HOME/profiles (default: web).\n'
    + '  --source    Package spec to install (default: fixed v1.1.0 release).\n'
    + '  -h, --help  Show this help.')
}

function runInstall(profileDir) {
  for (const [command, args] of [
    ['pnpm', ['install', '--ignore-scripts']],
    ['corepack', ['pnpm', 'install', '--ignore-scripts']],
  ]) {
    const result = spawnSync(command, args, { cwd: profileDir, stdio: 'inherit' })
    if (!result.error && result.status === 0) return
    if (result.error?.code !== 'ENOENT') throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
  throw new Error('pnpm is unavailable; install pnpm or enable it with corepack')
}

async function atomicWrite(path, content) {
  const temp = `${path}.dsh-subscription-search.tmp`
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

async function loadManifest(packagePath) {
  let text
  try { text = await readFile(packagePath, 'utf8') }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`no DSH profile manifest at ${packagePath}`)
    throw error
  }
  try { return { text, pkg: JSON.parse(text) } }
  catch { throw new Error(`malformed profile manifest at ${packagePath}`) }
}

function applyOwnEntries(pkg, source) {
  pkg.dependencies ||= {}
  pkg.dependencies[PACKAGE_NAME] = source
  pkg.dsh ||= {}
  pkg.dsh.profile ||= {}
  pkg.dsh.profile.bundles ||= []
  if (!Array.isArray(pkg.dsh.profile.bundles)) throw new Error('dsh.profile.bundles must be an array')
  if (!pkg.dsh.profile.bundles.includes(PACKAGE_NAME)) pkg.dsh.profile.bundles.push(PACKAGE_NAME)
}

async function install(profileDir, source) {
  const packagePath = join(profileDir, 'package.json')
  const { text, pkg } = await loadManifest(packagePath)
  applyOwnEntries(pkg, source)
  const updated = `${JSON.stringify(pkg, null, 2)}\n`
  const wrote = updated !== text
  if (wrote) await atomicWrite(packagePath, updated)
  try { runInstall(profileDir) }
  catch (error) { if (wrote) await atomicWrite(packagePath, text); throw error }
  console.log(`\nInstalled ${PACKAGE_NAME} (${source}) into ${profileDir}`)
  console.log('Manually restart DSH, then force-refresh the existing Web GUI.')
}

async function status(profileDir) {
  const { pkg } = await loadManifest(join(profileDir, 'package.json'))
  const ref = pkg?.dependencies?.[PACKAGE_NAME]
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const bundled = bundles.includes(PACKAGE_NAME)
  let version
  try { version = JSON.parse(await readFile(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8')).version } catch {}
  console.log(`profile: ${profileDir}`)
  console.log(`dependency: ${typeof ref === 'string' ? ref : '(absent)'}`)
  console.log(`bundle entry: ${bundled ? PACKAGE_NAME : '(absent)'}`)
  console.log(`installed copy: ${version === undefined ? 'missing' : `v${version}`}`)
  if (ref === undefined && !bundled && version === undefined) {
    console.log(`${PACKAGE_NAME} is not installed`); process.exitCode = 1
  } else if (typeof ref === 'string' && bundled && version !== undefined) console.log(`${PACKAGE_NAME} is installed`)
  else { console.log(`${PACKAGE_NAME} is partially installed; run \`${PACKAGE_NAME} install\` to repair`); process.exitCode = 1 }
}

async function uninstall(profileDir) {
  const packagePath = join(profileDir, 'package.json')
  const { text, pkg } = await loadManifest(packagePath)
  let changed = false
  if (pkg?.dependencies && PACKAGE_NAME in pkg.dependencies) { delete pkg.dependencies[PACKAGE_NAME]; changed = true }
  if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
    const remaining = pkg.dsh.profile.bundles.filter(name => name !== PACKAGE_NAME)
    if (remaining.length !== pkg.dsh.profile.bundles.length) { pkg.dsh.profile.bundles = remaining; changed = true }
  }
  const modulePresent = existsSync(join(profileDir, 'node_modules', PACKAGE_NAME))
  if (!changed && !modulePresent) { console.log(`${PACKAGE_NAME} is not installed in ${profileDir}`); return }
  if (changed) await atomicWrite(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  if (modulePresent) {
    try { runInstall(profileDir) }
    catch (error) { if (changed) await atomicWrite(packagePath, text); throw error }
  }
  console.log(`Uninstalled ${PACKAGE_NAME} from ${profileDir}`)
  console.log('Manually restart DSH, then force-refresh the existing Web GUI.')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()
  const profileDir = join(resolve(process.env.DSH_HOME || join(homedir(), '.dsh')), 'profiles', options.profile)
  if (options.command === 'status') return status(profileDir)
  if (options.command === 'uninstall') return uninstall(profileDir)
  return install(profileDir, options.source)
}

main().catch(error => {
  console.error(`${fileURLToPath(import.meta.url)}: ${error instanceof Error ? error.message : String(error)}`)
  console.error(`Run \`${PACKAGE_NAME} --help\` for usage.`)
  process.exitCode = 1
})
