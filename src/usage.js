/**
 * Secret-free weekly (and Codex 5-hour) usage snapshots for ChatGPT / Grok
 * subscriptions. Parsers accept only bounded numeric fields; tokens, account
 * ids, and upstream error bodies never leave this module.
 */

export const USAGE_CACHE_TTL_MS = 60_000
export const USAGE_TIMEOUT_MS = 10_000

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const GROK_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const USER_AGENT = 'dsh-subscription-search/0.1.4'
const GROK_CLIENT_VERSION = '1.0.3'
const PROVIDERS = ['openai-codex', 'xai']
const ERROR_CODES = new Set(['USAGE_UNAVAILABLE', 'USAGE_UNAUTHORIZED', 'USAGE_TIMEOUT'])

export class UsageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UsageError'
    this.code = code
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError'
}

export function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function parseResetAt(window, now) {
  const fromAt = parseTimestamp(window.reset_at)
  if (fromAt !== undefined) return fromAt
  const after = finiteNumber(window.reset_after_seconds)
  if (after !== undefined && after >= 0) return now + after * 1000
  return undefined
}

function sanitizeWindow(window) {
  if (!isRecord(window) || (window.id !== 'weekly' && window.id !== 'primary')) return undefined
  const usedPercent = clampPercent(window.usedPercent)
  const remainingPercent = clampPercent(window.remainingPercent)
  if (usedPercent === undefined || remainingPercent === undefined) return undefined
  const sanitized = { id: window.id, usedPercent, remainingPercent }
  const resetsAt = finiteNumber(window.resetsAt)
  if (resetsAt !== undefined && resetsAt > 0) sanitized.resetsAt = resetsAt
  const windowSeconds = finiteNumber(window.windowSeconds)
  if (windowSeconds !== undefined && windowSeconds > 0) sanitized.windowSeconds = windowSeconds
  return sanitized
}

function sanitizeError(error) {
  if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') return undefined
  return {
    code: ERROR_CODES.has(error.code) ? error.code : 'USAGE_UNAVAILABLE',
    message: error.message.slice(0, 160),
  }
}

/** Drop any unexpected fields before the value crosses the browser channel. */
export function sanitizeUsage(value) {
  if (!isRecord(value) || (value.provider !== 'openai-codex' && value.provider !== 'xai')) {
    return { provider: 'openai-codex', available: false }
  }
  if (value.available !== true) return { provider: value.provider, available: false }
  const windows = []
  if (Array.isArray(value.windows)) {
    for (const window of value.windows) {
      const sanitized = sanitizeWindow(window)
      if (sanitized !== undefined) windows.push(sanitized)
    }
  }
  const result = {
    provider: value.provider,
    available: true,
    windows,
    fetchedAt: finiteNumber(value.fetchedAt) ?? 0,
  }
  if (value.stale === true) result.stale = true
  const error = sanitizeError(value.error)
  if (error !== undefined) result.error = error
  return result
}

function windowFromUsedPercent(id, usedPercent, extras = {}) {
  const used = clampPercent(usedPercent)
  if (used === undefined) return undefined
  return {
    id,
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    ...extras,
  }
}

const WEEKLY_WINDOW_SECONDS = 2 * 24 * 60 * 60

function classifyWindowId(seconds, fallbackId) {
  if (seconds !== undefined && seconds >= WEEKLY_WINDOW_SECONDS) return 'weekly'
  if (seconds !== undefined && seconds > 0) return 'primary'
  return fallbackId
}

function windowFromRaw(raw, fallbackId, now) {
  if (!isRecord(raw)) return undefined
  const seconds = finiteNumber(raw.limit_window_seconds)
  const extras = {}
  const resetsAt = parseResetAt(raw, now)
  if (resetsAt !== undefined) extras.resetsAt = resetsAt
  if (seconds !== undefined && seconds > 0) extras.windowSeconds = seconds
  return windowFromUsedPercent(classifyWindowId(seconds, fallbackId), raw.used_percent, extras)
}

function pushWindow(windows, window) {
  if (window === undefined || windows.some(existing => existing.id === window.id)) return
  windows.push(window)
}

export function parseCodexUsage(payload, now = Date.now()) {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return undefined
  const windows = []
  pushWindow(windows, windowFromRaw(payload.rate_limit.primary_window, 'primary', now))
  pushWindow(windows, windowFromRaw(payload.rate_limit.secondary_window, 'weekly', now))
  return windows.length === 0 ? undefined : windows
}

export function parseGrokUsage(payload, now = Date.now()) {
  const config = isRecord(payload) && isRecord(payload.config) ? payload.config : payload
  if (!isRecord(config)) return undefined
  const extras = { windowSeconds: 604800 }
  const period = config.currentPeriod
  if (isRecord(period) && typeof period.end === 'string') {
    const resetsAt = parseTimestamp(period.end)
    if (resetsAt !== undefined) extras.resetsAt = resetsAt
  }
  const weekly = windowFromUsedPercent('weekly', config.creditUsagePercent, extras)
  return weekly === undefined ? undefined : [weekly]
}

function usageError(code, message) {
  return new UsageError(code, message)
}

function mapFetchError(error) {
  if (error instanceof UsageError) return error
  if (isAbortError(error)) return usageError('USAGE_TIMEOUT', 'Usage request timed out')
  return usageError('USAGE_UNAVAILABLE', 'Usage is temporarily unavailable')
}

function composeSignal(signal) {
  const timeout = AbortSignal.timeout(USAGE_TIMEOUT_MS)
  if (signal === undefined) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return timeout
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    throw usageError('USAGE_UNAVAILABLE', 'Usage is temporarily unavailable')
  }
}

async function requestUsage(fetchImpl, url, headers, signal) {
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers, signal })
  } catch (error) {
    throw mapFetchError(error)
  }
  if (response.status === 401 || response.status === 403) {
    throw usageError('USAGE_UNAUTHORIZED', 'Sign in again to see usage')
  }
  if (!response.ok) throw usageError('USAGE_UNAVAILABLE', 'Usage is temporarily unavailable')
  return readJson(response)
}

async function fetchCodexUsage(oauth, { fetchImpl, signal, now }) {
  const payload = await requestUsage(fetchImpl, CODEX_USAGE_URL, {
    authorization: `Bearer ${oauth.apiKey}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...oauth.headers ?? {},
  }, signal)
  const windows = parseCodexUsage(payload, now())
  if (windows === undefined) throw usageError('USAGE_UNAVAILABLE', 'Usage is temporarily unavailable')
  return sanitizeUsage({
    provider: 'openai-codex',
    available: true,
    windows,
    fetchedAt: now(),
  })
}

async function fetchGrokUsage(oauth, { fetchImpl, signal, now }) {
  const payload = await requestUsage(fetchImpl, GROK_USAGE_URL, {
    authorization: `Bearer ${oauth.apiKey}`,
    accept: 'application/json',
    'user-agent': 'grok-shell',
    'x-grok-client-version': GROK_CLIENT_VERSION,
    ...oauth.headers ?? {},
  }, signal)
  const windows = parseGrokUsage(payload, now())
  if (windows === undefined) throw usageError('USAGE_UNAVAILABLE', 'Usage is temporarily unavailable')
  return sanitizeUsage({
    provider: 'xai',
    available: true,
    windows,
    fetchedAt: now(),
  })
}

function unavailable(provider) {
  return { provider, available: false }
}

function failed(provider, error, previous, now) {
  const result = {
    provider,
    available: true,
    windows: previous?.windows ?? [],
    fetchedAt: now(),
    error: { code: error.code, message: error.message },
    ...previous?.windows?.length ? { stale: true } : {},
  }
  return sanitizeUsage(result)
}

/** Cached, secret-free usage snapshots for the two subscription providers. */
export function createUsageService({
  auth,
  sync,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = USAGE_CACHE_TTL_MS,
} = {}) {
  const cache = new Map()
  const inFlight = new Map()

  const fetchProvider = (provider, { refresh = false, signal } = {}) => {
    const cached = cache.get(provider)
    if (!refresh && cached !== undefined && now() - cached.fetchedAt < cacheTtlMs) {
      return Promise.resolve(cached.value)
    }
    const active = inFlight.get(provider)
    if (active !== undefined && !refresh) return active

    const operation = (async () => {
      if (!auth.configured(provider)) {
        const value = unavailable(provider)
        cache.delete(provider)
        return value
      }
      let oauth
      try {
        await sync?.(provider, 'usage')
        oauth = await auth.resolveOAuth(provider, signal)
      } catch {
        return failed(provider, usageError('USAGE_UNAUTHORIZED', 'Sign in again to see usage'), cached?.value, now)
      }
      if (oauth === undefined || oauth.apiKey.length === 0) {
        cache.delete(provider)
        return unavailable(provider)
      }
      try {
        const value = provider === 'openai-codex'
          ? await fetchCodexUsage(oauth, { fetchImpl, signal: composeSignal(signal), now })
          : await fetchGrokUsage(oauth, { fetchImpl, signal: composeSignal(signal), now })
        cache.set(provider, { value, fetchedAt: value.fetchedAt })
        return value
      } catch (error) {
        return failed(provider, mapFetchError(error), cached?.value, now)
      }
    })()

    const tracked = operation.finally(() => {
      if (inFlight.get(provider) === tracked) inFlight.delete(provider)
    })
    inFlight.set(provider, tracked)
    return tracked
  }

  return {
    fetchProvider,
    fetchAll(options) {
      return Promise.all(PROVIDERS.map(provider => fetchProvider(provider, options)))
    },
    clear(provider) {
      if (provider === undefined) cache.clear()
      else cache.delete(provider)
    },
  }
}
