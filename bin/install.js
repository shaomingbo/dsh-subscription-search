#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-subscription-search'
const COMMANDS = ['install', 'status', 'uninstall']
const SUPERSEDED_BRIDGES = ['dsh-codex-auth-bridge', 'dsh-grok-build-auth-bridge']

/**
 * Pin the default source to the SemVer tag of the copy that is running, so
 * installing from any published tag records exactly that tag — never a stale
 * hardcode or a floating branch.
 */
function defaultSource() {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  return `github:shaomingbo/dsh-subscription-search#v${JSON.parse(readFileSync(pkgPath, 'utf8')).version}`
}

function parseArgs(argv) {
  const result = {
    command: undefined,
    profile: 'web',
    source: process.env.DSH_SUBSCRIPTION_SEARCH_SOURCE || defaultSource(),
  }
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
  // No arguments means plain installation.
  result.command ??= 'install'
  return result
}

function printHelp() {
  console.log(
    `Usage: ${PACKAGE_NAME} [install|status|uninstall] [--profile web] [--source github:shaomingbo/dsh-subscription-search#vX.Y.Z]\n\n`
      + `Commands:\n`
      + `  install     Install into a DSH profile and add its Cordis bundle (default).\n`
      + `  status      Report whether the target profile has this plugin installed.\n`
      + `  uninstall   Remove the dependency reference and Cordis bundle entry.\n\n`
      + `Flags:\n`
      + `  --profile   Target profile name under $DSH_HOME/profiles (default: web).\n`
      + `  --source    Package spec written into the manifest; defaults to this copy's own tag.\n`
      + `  -h, --help  Show this help.`,
  )
}

/** Run the dependency toolchain in the profile directory; lifecycle scripts stay disabled. */
function runInstall(profileDir) {
  const attempts = [
    ['pnpm', ['install', '--ignore-scripts']],
    ['corepack', ['pnpm', 'install', '--ignore-scripts']],
  ]
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { cwd: profileDir, stdio: 'inherit' })
    if (!result.error && result.status === 0) return
    if (result.error?.code !== 'ENOENT') {
      throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
    }
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

/** Load and parse the profile manifest without tolerating corruption. */
async function loadManifest(packagePath) {
  let text
  try {
    text = await readFile(packagePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`no DSH profile manifest at ${packagePath}`)
    throw error
  }
  try {
    return { text, pkg: JSON.parse(text) }
  } catch {
    throw new Error(`malformed profile manifest at ${packagePath}`)
  }
}

/** Remove bridge-owned llm-pi-ai routes from the user settings document. */
async function cleanBridgeRoutes(settingsPath) {
  let text
  try {
    text = await readFile(settingsPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const original = text
  // Delete the bridge-owned routes from the llm-pi-ai providers dict; keep
  // every other provider untouched. grok-build carries the bridge client
  // identifier header; openai-codex names the bridge credential reference.
  text = text.replace(
    /^ {4}grok-build:\n(?: {6}[^\n]*\n)+/m,
    '',
  )
  text = text.replace(
    /^ {4}openai-codex:\n(?: {6}[^\n]*\n)+/m,
    '',
  )
  if (text !== original) {
    await writeFile(settingsPath, text, 'utf8')
    console.log('Removed bridge-owned routes (grok-build / openai-codex) from settings.yaml')
  }
}

/** Remove a workspace-override package from the profile node_modules. */
async function removeWorkspaceOverrides(profileDir) {
  // When developing locally the profile may symlink packages to a workspace
  // checkout; the shipped ui-settings-models has no subscription cards, and a
  // checkout copy calls providerAuth RPCs the published host does not expose.
  const overrides = [
    '@deepseek-ai/dsh-client-ui-settings-models',
    '@deepseek-ai/dsh-client-ui-search-settings',
  ]
  for (const name of overrides) {
    const target = join(profileDir, 'node_modules', name)
    try {
      const stat = await import('node:fs/promises').then(fs => fs.lstat(target))
      if (stat.isSymbolicLink()) {
        await rm(target, { recursive: true, force: true })
        console.log(`Removed workspace symlink ${name} (the published package re-installs on pnpm install)`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function appliedManifest(pkg) {
  pkg.dependencies ||= {}
  pkg.dsh ||= {}
  pkg.dsh.profile ||= {}
  pkg.dsh.profile.bundles ||= []
  if (!pkg.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    pkg.dsh.profile.bundles.push(PACKAGE_NAME)
  }
  // The two CLI-auth bridges are superseded: they read ~/.codex/auth.json and
  // ~/.grok/auth.json and replace the whole llm-pi-ai config. This plugin owns
  // its own OAuth, so remove them from the bundle stack. The dependencies stay
  // (harmless) unless the user removes them explicitly.
  const bundles = pkg.dsh.profile.bundles
  const remaining = bundles.filter(name => !SUPERSEDED_BRIDGES.includes(name))
  const removed = bundles.filter(name => SUPERSEDED_BRIDGES.includes(name))
  if (removed.length > 0) {
    pkg.dsh.profile.bundles = remaining
    console.log(`Removed superseded bridge bundles: ${removed.join(', ')}`)
    console.log('  Their dependencies remain in package.json; remove them with:')
    console.log('  dsh plugin remove dsh-codex-auth-bridge dsh-grok-build-auth-bridge')
  }
  return pkg
}

async function install(dshHome, profileDir, source) {
  const packagePath = join(profileDir, 'package.json')
  const { text, pkg } = await loadManifest(packagePath)

  // Remove stale bridge routes from settings and workspace symlinks before
  // installing, so the first boot after restart is fully native.
  await cleanBridgeRoutes(join(dshHome, 'settings.yaml'))
  await removeWorkspaceOverrides(profileDir)

  const previous = pkg.dependencies?.[PACKAGE_NAME]
  pkg.dependencies ||= {}
  pkg.dependencies[PACKAGE_NAME] = source
  appliedManifest(pkg)
  const updated = `${JSON.stringify(pkg, null, 2)}\n`
  const wrote = updated !== text
  if (wrote) await atomicWrite(packagePath, updated)
  if (previous !== source && previous !== undefined) {
    console.log(`Updated ${PACKAGE_NAME}: ${previous} → ${source}`)
  }

  try {
    runInstall(profileDir)
  } catch (error) {
    if (wrote) await atomicWrite(packagePath, text)
    throw error
  }

  console.log(`\nInstalled ${PACKAGE_NAME} (${source}) into ${profileDir}`)
  console.log('Restart DSH so the new host bundle is composed.')
}

async function status(profileDir) {
  const packagePath = join(profileDir, 'package.json')
  const { pkg } = await loadManifest(packagePath)
  const ref = pkg?.dependencies?.[PACKAGE_NAME]
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const bundled = bundles.includes(PACKAGE_NAME)
  let version
  try {
    version = JSON.parse(await readFile(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8')).version
  } catch {}

  console.log(`profile: ${profileDir}`)
  console.log(`dependency: ${typeof ref === 'string' ? ref : '(absent)'}`)
  console.log(`bundle entry: ${bundled ? PACKAGE_NAME : '(absent)'}`)
  console.log(`installed copy: ${version === undefined ? 'missing' : `v${version}`}`)

  if (ref === undefined && !bundled && version === undefined) {
    console.log(`${PACKAGE_NAME} is not installed`)
    process.exitCode = 1
  } else if (typeof ref === 'string' && bundled && version !== undefined) {
    console.log(`${PACKAGE_NAME} is installed`)
  } else {
    console.log(`${PACKAGE_NAME} is partially installed; run \`${PACKAGE_NAME} install\` to repair`)
    process.exitCode = 1
  }
}

async function uninstall(profileDir) {
  const packagePath = join(profileDir, 'package.json')
  const { text, pkg } = await loadManifest(packagePath)

  let changed = false
  if (pkg?.dependencies && PACKAGE_NAME in pkg.dependencies) {
    delete pkg.dependencies[PACKAGE_NAME]
    changed = true
  }
  if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
    const remaining = pkg.dsh.profile.bundles.filter(name => name !== PACKAGE_NAME)
    if (remaining.length !== pkg.dsh.profile.bundles.length) {
      pkg.dsh.profile.bundles = remaining
      changed = true
    }
  }
  const modulePresent = existsSync(join(profileDir, 'node_modules', PACKAGE_NAME))

  if (!changed && !modulePresent) {
    console.log(`${PACKAGE_NAME} is not installed in ${profileDir}`)
    return
  }

  const wrote = changed
  if (changed) await atomicWrite(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  if (modulePresent) {
    try {
      runInstall(profileDir)
    } catch (error) {
      if (wrote) await atomicWrite(packagePath, text)
      throw error
    }
  }

  console.log(`Uninstalled ${PACKAGE_NAME} from ${profileDir}`)
  console.log('Restart DSH so the host stops composing the removed bundle.')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()

  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profileDir = join(dshHome, 'profiles', options.profile)
  if (options.command === 'status') return status(profileDir)
  if (options.command === 'uninstall') return uninstall(profileDir)
  return install(dshHome, profileDir, options.source)
}

main().catch((error) => {
  const script = fileURLToPath(import.meta.url)
  console.error(`${script}: ${error instanceof Error ? error.message : String(error)}`)
  console.error(`Run \`dsh-subscription-search --help\` for usage.`)
  process.exitCode = 1
})
