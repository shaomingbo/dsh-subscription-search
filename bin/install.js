#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-subscription-search'
const COMMANDS = ['install', 'status', 'uninstall']
const SUPERSEDED_BRIDGES = ['dsh-codex-auth-bridge', 'dsh-grok-build-auth-bridge']
const WORKSPACE_OVERRIDES = [
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-search-settings',
]

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

/**
 * Detect pre-existing state this installer must not touch. The installer is
 * only allowed to edit its own dependency and bundle entry, so any superseded
 * bridge bundle, bridge-owned settings route, or workspace override symlink is
 * reported for manual migration — never mutated.
 */
async function detectLegacyState(dshHome, pkg, profileDir) {
  const facts = []
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const bridgeBundles = bundles.filter(name => SUPERSEDED_BRIDGES.includes(name))
  if (bridgeBundles.length > 0) {
    facts.push(`superseded bridge bundles in the profile manifest: ${bridgeBundles.join(', ')}`)
  }
  const settingsPath = join(dshHome, 'settings.yaml')
  let settings
  try {
    settings = await readFile(settingsPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (settings !== undefined) {
    const routes = ['grok-build', 'openai-codex'].filter(name => new RegExp(`^\\s+${name}:\\s*$`, 'm').test(settings))
    if (routes.length > 0) {
      facts.push(`bridge-owned routes in settings.yaml: ${routes.join(', ')}`)
    }
  }
  for (const name of WORKSPACE_OVERRIDES) {
    const target = join(profileDir, 'node_modules', name)
    try {
      if (lstatSync(target).isSymbolicLink()) facts.push(`workspace override symlink: ${name}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return facts
}

function printMigrationGuidance(facts) {
  console.error('legacy state detected; install blocked until the manual migration is done:')
  for (const fact of facts) console.error(`  - ${fact}`)
  console.error('manual migration:')
  console.error('  1. remove the superseded bridge bundles (and their dependencies) from the profile manifest')
  console.error('  2. remove the grok-build / openai-codex routes from settings.yaml by hand')
  console.error('  3. delete the workspace override symlinks, then run pnpm install --ignore-scripts')
  console.error('this installer only edits its own dependency and bundle entry;')
  console.error('it never touches settings.yaml, other bundles, node_modules symlinks, or any credential store.')
}

function appliedManifest(pkg) {
  pkg.dependencies ||= {}
  pkg.dsh ||= {}
  pkg.dsh.profile ||= {}
  pkg.dsh.profile.bundles ||= []
  if (!pkg.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    pkg.dsh.profile.bundles.push(PACKAGE_NAME)
  }
  return pkg
}

async function install(dshHome, profileDir, source) {
  const packagePath = join(profileDir, 'package.json')
  const { text, pkg } = await loadManifest(packagePath)

  // Legacy state blocks the install: the installer must not mutate settings,
  // other bundles, or node_modules symlinks, so the owner migrates by hand.
  const legacyFacts = await detectLegacyState(dshHome, pkg, profileDir)
  if (legacyFacts.length > 0) {
    printMigrationGuidance(legacyFacts)
    process.exitCode = 1
    return
  }

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

async function status(profileDir, dshHome) {
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

  const legacyFacts = await detectLegacyState(dshHome, pkg, profileDir)
  if (legacyFacts.length > 0) {
    console.log('legacy state detected (install blocked until the manual migration is done):')
    for (const fact of legacyFacts) console.log(`  - ${fact}`)
  }

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
  if (options.command === 'status') return status(profileDir, dshHome)
  if (options.command === 'uninstall') return uninstall(profileDir)
  return install(dshHome, profileDir, options.source)
}

main().catch((error) => {
  const script = fileURLToPath(import.meta.url)
  console.error(`${script}: ${error instanceof Error ? error.message : String(error)}`)
  console.error(`Run \`dsh-subscription-search --help\` for usage.`)
  process.exitCode = 1
})
