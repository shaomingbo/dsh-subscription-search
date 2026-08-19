/**
 * Owner-only JSON persistence for pi-ai OAuth credentials.
 *
 * Standalone port of the DSH pi-ai auth store with no workspace-only
 * dependencies: node:fs atomic writes, 0600 file / 0700 directory modes, a
 * process-local operation queue, and last-good-snapshot survival when an
 * external edit is invalid.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const FORMAT_VERSION = 1
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertProviderId(providerId) {
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error('subscription-search: document contains an invalid provider id')
  }
}

function oauthCredential(providerId, value) {
  if (!isRecord(value) || value.type !== 'oauth') {
    throw new Error(`subscription-search: credential for "${providerId}" must have type "oauth"`)
  }
  if (typeof value.access !== 'string' || value.access.length === 0) {
    throw new Error(`subscription-search: credential for "${providerId}" has no access token`)
  }
  if (typeof value.refresh !== 'string' || value.refresh.length === 0) {
    throw new Error(`subscription-search: credential for "${providerId}" has no refresh token`)
  }
  if (typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires <= 0) {
    throw new Error(`subscription-search: credential for "${providerId}" has an invalid expiry`)
  }
  return value
}

export function parseOAuthDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const position = error instanceof SyntaxError ? error.message.match(/position \d+/)?.[0] : undefined
    throw new Error(`subscription-search: the OAuth document is not valid JSON${position === undefined ? '' : ` (${position})`}`)
  }
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION) {
    throw new Error(`subscription-search: the OAuth document has an unsupported version`)
  }
  if (!isRecord(parsed.credentials)) {
    throw new Error('subscription-search: the OAuth document has no credentials object')
  }
  const credentials = new Map()
  for (const [providerId, value] of Object.entries(parsed.credentials)) {
    assertProviderId(providerId)
    credentials.set(providerId, oauthCredential(providerId, value))
  }
  return credentials
}

export class OAuthCredentialFileStore {
  constructor(options) {
    this.options = options
    this.credentials = new Map()
    this.closed = false
    this.operations = Promise.resolve()
  }

  async init() {
    try {
      await this.reload()
    } catch (error) {
      this.options.onError(error)
    }
  }

  has(providerId) {
    return this.credentials.has(providerId)
  }

  get(providerId) {
    return this.credentials.get(providerId)
  }

  async read(providerId) {
    return this.credentials.get(providerId)
  }

  list() {
    return [...this.credentials.keys()]
  }

  /** Serialize one mutation behind earlier ones and publish committed changes. */
  modify(mutator) {
    const task = this.operations.then(async () => {
      if (this.closed) return
      const previous = new Map(this.credentials)
      const draft = new Map(previous)
      const returned = mutator(draft)
      const next = returned ?? draft
      if (sameCredentials(previous, next)) return
      const document = {
        version: FORMAT_VERSION,
        credentials: Object.fromEntries(
          [...next.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => [id, value]),
        ),
      }
      await this.writeDocument(document)
      this.credentials = next
      for (const providerId of changedProviders(previous, next)) {
        this.options.onChanged(providerId)
      }
    })
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Replace the document from a fresh read; keeps the last good snapshot on failure. */
  async reload() {
    if (this.closed) return
    let text
    try {
      text = await readFile(this.options.filename, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.credentials = new Map()
        return
      }
      throw error
    }
    try {
      this.credentials = parseOAuthDocument(text)
    } catch (error) {
      this.options.onError(error)
    }
  }

  async writeDocument(document) {
    await mkdir(dirname(this.options.filename), { recursive: true, mode: 0o700 })
    const temp = `${this.options.filename}.tmp-${process.pid}`
    try {
      await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' })
      await chmod(temp, 0o600)
      await rename(temp, this.options.filename)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  /** Enqueue one operation behind earlier ones. */
  enqueue(operation) {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  async dispose() {
    this.closed = true
    await this.operations
  }
}

function sameCredentials(left, right) {
  if (left.size !== right.size) return false
  for (const [providerId, value] of left) {
    if (!credentialEquals(value, right.get(providerId))) return false
  }
  return true
}

function credentialEquals(left, right) {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

function changedProviders(previous, next) {
  const ids = new Set([...previous.keys(), ...next.keys()])
  const changed = []
  for (const providerId of ids) {
    if (!credentialEquals(previous.get(providerId), next.get(providerId))) changed.push(providerId)
  }
  return changed
}
