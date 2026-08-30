const PROTOCOL = 'search-chain/v1'
const DEFAULT_ORDER = Object.freeze(['chatgpt', 'grok', 'exa', 'deepseek'])
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const LABELS = Object.freeze({ chatgpt: 'ChatGPT', grok: 'Grok', exa: 'Exa', deepseek: 'DeepSeek' })
const MIN_TIMEOUT_MS = 1
const MAX_TIMEOUT_MS = 300_000
const MAX_BACKENDS = 32
const MIN_STATUS_TIMEOUT_MS = 1
const MAX_STATUS_TIMEOUT_MS = 30_000
const DEFAULT_STATUS_TIMEOUT_MS = 2_000

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  enabled: Object.freeze({ chatgpt: true, grok: true, exa: true, deepseek: true }),
  order: DEFAULT_ORDER,
  perLegTimeoutMs: 60_000,
  totalTimeoutMs: 240_000,
})

export class SearchChainError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SearchChainError'
    this.code = code
  }
}

function safeCode(error) {
  return typeof error?.code === 'string' && SAFE_CODE_PATTERN.test(error.code)
    ? error.code
    : 'SEARCH_BACKEND_ERROR'
}

function timeout(value, fallback) {
  return Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS ? value : fallback
}

function normalizePolicy(value, fallback = DEFAULT_SETTINGS) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const sourceOrder = Array.isArray(input.order) ? input.order : fallback.order
  const order = []
  for (const id of [...sourceOrder, ...fallback.order, ...DEFAULT_ORDER]) {
    if (typeof id === 'string' && ID_PATTERN.test(id) && !order.includes(id)) order.push(id)
    if (order.length === MAX_BACKENDS) break
  }
  const enabledInput = input.enabled && typeof input.enabled === 'object' && !Array.isArray(input.enabled) ? input.enabled : {}
  const enabled = {}
  for (const id of order) enabled[id] = enabledInput[id] ?? fallback.enabled?.[id] ?? true
  return {
    version: 1,
    enabled,
    order,
    perLegTimeoutMs: timeout(input.perLegTimeoutMs, fallback.perLegTimeoutMs),
    totalTimeoutMs: timeout(input.totalTimeoutMs, fallback.totalTimeoutMs),
  }
}

function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

async function runAbortable(operation, signal) {
  const work = Promise.resolve().then(() => operation(signal))
  work.catch(() => {})
  return Promise.race([work, abortPromise(signal)])
}

/**
 * One backend's reported availability, or 'unknown' when it reports nothing
 * recognizable. Accepts a callable probe (async or sync) or a static object,
 * so a backend can report configuration state without exposing secrets.
 * A probe that outlives its deadline reads as 'unknown', never blocks refresh.
 */
function reportedAvailability(reported) {
  const value = reported?.availability
  return value === 'available' || value === 'unavailable' ? value : 'unknown'
}

async function probeAvailability(backend, timeoutMs) {
  if (backend === undefined) return 'unregistered'
  let reported
  if (typeof backend.status === 'function') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new SearchChainError('SEARCH_STATUS_TIMEOUT', 'Search status probe timed out')), timeoutMs)
    timer.unref?.()
    try {
      reported = await runAbortable(signal => backend.status(signal), controller.signal)
    } catch {
      return 'unknown'
    } finally {
      clearTimeout(timer)
    }
  } else {
    reported = backend.status
  }
  return reportedAvailability(reported)
}

function validateResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.sources)) {
    throw new SearchChainError('SEARCH_INVALID_RESULT', 'Search backend returned an invalid result')
  }
  return value
}

function isEmpty(value) {
  return value.sources.length === 0 && !(typeof value.content === 'string' && value.content.length > 0)
}

/**
 * Deep Host module at the search-chain/v1 seam.
 *
 * Backends implement `{ id, search(request, signal) }` plus two optional
 * probes: `available(signal)` gates one search leg, and `status(signal)`
 * (or a static `status` object) feeds `probe()` and the synchronous `list()`
 * cache with a secret-free `{ availability: 'available' | 'unavailable' }`.
 * Ordering, policy, deadlines, fallback, cancellation, empty-result semantics,
 * lifecycle replacement, and bounded secret-free diagnostics stay here.
 */
export class SearchChain {
  constructor({ settings = DEFAULT_SETTINGS, diagnosticsLimit = 20, statusTimeoutMs = DEFAULT_STATUS_TIMEOUT_MS, now = () => Date.now() } = {}) {
    this.settings = normalizePolicy(settings)
    this.diagnosticsLimit = Math.max(1, Math.min(100, diagnosticsLimit))
    this.statusTimeoutMs = Math.max(MIN_STATUS_TIMEOUT_MS, Math.min(MAX_STATUS_TIMEOUT_MS, statusTimeoutMs))
    this.now = now
    this.backends = new Map()
    this.availability = new Map()
    this.diagnostics = []
  }

  register(backend) {
    if (!backend || typeof backend !== 'object' || !ID_PATTERN.test(backend.id ?? '')) {
      throw new TypeError('search backend id must match /^[a-z][a-z0-9-]{0,63}$/')
    }
    if (typeof backend.search !== 'function') throw new TypeError('search backend must provide search(request, signal)')
    const token = Symbol(backend.id)
    this.backends.set(backend.id, { backend, token })
    this.availability.set(backend.id, { token, value: typeof backend.status === 'function' ? 'unknown' : reportedAvailability(backend.status) })
    if (!this.settings.order.includes(backend.id)) {
      this.settings = normalizePolicy({
        ...this.settings,
        order: [...this.settings.order, backend.id],
        enabled: { ...this.settings.enabled, [backend.id]: true },
      }, this.settings)
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.backends.get(backend.id)?.token === token) {
        this.backends.delete(backend.id)
        this.availability.delete(backend.id)
      }
    }
  }

  configure(settings) {
    this.settings = normalizePolicy(settings, this.settings)
    return this.list().settings
  }

  /**
   * Secret-free synchronous chain status, retaining the search-chain/v1
   * contract. Callable availability reflects the latest completed probe;
   * static status objects are read directly.
   */
  list() {
    const policy = normalizePolicy(this.settings)
    const known = [...policy.order]
    for (const id of this.backends.keys()) if (!known.includes(id)) known.push(id)
    return {
      protocol: PROTOCOL,
      settings: policy,
      backends: known.map(id => {
        const registered = this.backends.get(id)
        const backend = registered?.backend
        const cached = this.availability.get(id)
        const availability = backend === undefined
          ? 'unregistered'
          : typeof backend.status === 'function'
            ? cached?.token === registered.token ? cached.value : 'unknown'
            : reportedAvailability(backend.status)
        return {
          id,
          label: LABELS[id] ?? id,
          enabled: policy.enabled[id] ?? true,
          registered: backend !== undefined,
          availability,
        }
      }),
      diagnostics: this.diagnostics.map(entry => ({
        startedAt: entry.startedAt,
        durationMs: entry.durationMs,
        outcome: entry.outcome,
        attempts: entry.attempts.map(attempt => ({ ...attempt })),
      })),
    }
  }

  /** Concurrently refresh callable backend status with one bounded probe each. */
  async probe() {
    const captured = [...this.backends.entries()].map(([id, value]) => ({ id, ...value }))
    const results = await Promise.all(captured.map(async entry => ({
      ...entry,
      value: await probeAvailability(entry.backend, this.statusTimeoutMs),
    })))
    for (const result of results) {
      if (this.backends.get(result.id)?.token === result.token) {
        this.availability.set(result.id, { token: result.token, value: result.value })
      }
    }
    return this.list()
  }

  async search(request, policy, signal) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.query !== 'string' || request.query.trim() === '') {
      throw new SearchChainError('SEARCH_INVALID_REQUEST', 'Search request requires a non-empty query')
    }
    if (signal?.aborted) throw new SearchChainError('SEARCH_CANCELLED', 'Search cancelled')

    const effective = normalizePolicy(policy, this.settings)
    const startedAt = this.now()
    const diagnostic = { startedAt, durationMs: 0, outcome: 'error', attempts: [] }
    const overall = new AbortController()
    const cancel = () => overall.abort(new SearchChainError('SEARCH_CANCELLED', 'Search cancelled'))
    signal?.addEventListener('abort', cancel, { once: true })
    const totalTimer = setTimeout(() => overall.abort(new SearchChainError('SEARCH_TOTAL_TIMEOUT', 'Search total timeout exceeded')), effective.totalTimeoutMs)
    totalTimer.unref?.()

    try {
      for (const id of effective.order) {
        if (overall.signal.aborted) throw overall.signal.reason
        if (effective.enabled[id] === false) continue
        const backend = this.backends.get(id)?.backend
        if (backend === undefined) {
          diagnostic.attempts.push({ id, status: 'unavailable', durationMs: 0 })
          continue
        }
        const legStart = this.now()
        const leg = new AbortController()
        const abortLeg = () => leg.abort(overall.signal.reason)
        overall.signal.addEventListener('abort', abortLeg, { once: true })
        const legTimer = setTimeout(() => leg.abort(new SearchChainError('SEARCH_LEG_TIMEOUT', 'Search backend timeout exceeded')), effective.perLegTimeoutMs)
        legTimer.unref?.()
        try {
          const available = typeof backend.available === 'function'
            ? await runAbortable(childSignal => backend.available(childSignal), leg.signal)
            : true
          if (available === false) {
            diagnostic.attempts.push({ id, status: 'unavailable', durationMs: this.now() - legStart })
            continue
          }
          const value = validateResult(await runAbortable(childSignal => backend.search(request, childSignal), leg.signal))
          diagnostic.attempts.push({ id, status: isEmpty(value) ? 'empty' : 'success', durationMs: this.now() - legStart })
          diagnostic.outcome = isEmpty(value) ? 'empty' : 'success'
          return value
        } catch (error) {
          if (overall.signal.aborted) throw overall.signal.reason
          if (leg.signal.aborted && leg.signal.reason?.code === 'SEARCH_LEG_TIMEOUT') {
            diagnostic.attempts.push({ id, status: 'timeout', durationMs: this.now() - legStart })
          } else {
            diagnostic.attempts.push({ id, status: 'error', code: safeCode(error), durationMs: this.now() - legStart })
          }
        } finally {
          clearTimeout(legTimer)
          overall.signal.removeEventListener('abort', abortLeg)
        }
      }
      throw new SearchChainError('SEARCH_CHAIN_EXHAUSTED', 'Search chain exhausted without a successful backend')
    } catch (error) {
      diagnostic.outcome = error?.code === 'SEARCH_CANCELLED'
        ? 'cancelled'
        : error?.code === 'SEARCH_TOTAL_TIMEOUT' ? 'timeout' : 'error'
      if (error instanceof SearchChainError) throw error
      throw new SearchChainError('SEARCH_CHAIN_EXHAUSTED', 'Search chain exhausted without a successful backend')
    } finally {
      clearTimeout(totalTimer)
      signal?.removeEventListener('abort', cancel)
      diagnostic.durationMs = Math.max(0, this.now() - startedAt)
      this.diagnostics.push(diagnostic)
      if (this.diagnostics.length > this.diagnosticsLimit) this.diagnostics.splice(0, this.diagnostics.length - this.diagnosticsLimit)
    }
  }
}

export const SEARCH_CHAIN_PROTOCOL = PROTOCOL
