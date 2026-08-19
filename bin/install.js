#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-subscription-search'
const DEFAULT_SOURCE = 'github:shaomingbo/dsh-subscription-search#v0.1.2'
const SUPERSEDED_BRIDGES = ['dsh-codex-auth-bridge', 'dsh-grok-build-auth-bridge']

function parseArgs(argv) {
  const result = { profile: 'web', source: process.env.DSH_SUBSCRIPTION_SEARCH_SOURCE || DEFAULT_SOURCE }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') result.profile = argv[++index]
    else if (arg === '--source') result.source = argv[++index]
    else if (arg === '--help' || arg === '-h') result.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!result.profile || !result.source) throw new Error('--profile and --source require values')
  return result
}

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

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`Usage: ${PACKAGE_NAME} [--profile web] [--source github:shaomingbo/dsh-subscription-search#v0.1.2]\n\nInstalls the package into a DSH profile and adds its Cordis bundle.`)
    return
  }

  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profileDir = join(dshHome, 'profiles', options.profile)
  const packagePath = join(profileDir, 'package.json')
  const original = await readFile(packagePath, 'utf8')
  const pkg = JSON.parse(original)

  // Remove stale bridge routes from settings and workspace symlinks before
  // installing, so the first boot after restart is fully native.
  await cleanBridgeRoutes(join(dshHome, 'settings.yaml'))
  await removeWorkspaceOverrides(profileDir)

  pkg.dependencies ||= {}
  pkg.dependencies[PACKAGE_NAME] = options.source
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
    console.log(`  dsh plugin --profile ${options.profile} remove ${removed.join(' ')}`)
  }

  await atomicWrite(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  try {
    runInstall(profileDir)
  } catch (error) {
    await atomicWrite(packagePath, original)
    throw error
  }

  console.log(`\nInstalled ${PACKAGE_NAME} into ${profileDir}`)
  console.log('Restart DSH so the new host bundle is composed.')
}

main().catch((error) => {
  const script = fileURLToPath(import.meta.url)
  console.error(`${script}: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
