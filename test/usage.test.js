import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampPercent,
  createUsageService,
  parseCodexUsage,
  parseGrokUsage,
  sanitizeUsage,
} from '../lib/usage.js'

const NOW = 1_700_000_000_000

test('clampPercent rejects non-finite values and clamps the range', () => {
  assert.equal(clampPercent(42.5), 42.5)
  assert.equal(clampPercent(-4), 0)
  assert.equal(clampPercent(140), 100)
  assert.equal(clampPercent(Number.NaN), undefined)
  assert.equal(clampPercent('12'), undefined)
})

test('parseCodexUsage maps primary to 5h and secondary to weekly', () => {
  const windows = parseCodexUsage({
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: 20,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600,
      },
      secondary_window: {
        used_percent: 58,
        limit_window_seconds: 604800,
        reset_at: 1_700_086_400,
      },
    },
    access_token: 'sk-secret-should-not-leak',
  }, NOW)
  assert.deepEqual(windows, [
    { id: 'primary', usedPercent: 20, remainingPercent: 80, resetsAt: NOW + 3600_000, windowSeconds: 18000 },
    { id: 'weekly', usedPercent: 58, remainingPercent: 42, resetsAt: 1_700_086_400_000, windowSeconds: 604800 },
  ])
})

test('parseCodexUsage classifies a weekly-length primary window as weekly', () => {
  const windows = parseCodexUsage({
    plan_type: 'prolite',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 37,
        limit_window_seconds: 604800,
        reset_after_seconds: 400000,
        reset_at: 1_700_400_000,
      },
      secondary_window: null,
    },
    additional_rate_limits: [{
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 0, limit_window_seconds: 604800 },
      },
    }],
  }, NOW)
  assert.deepEqual(windows, [{
    id: 'weekly',
    usedPercent: 37,
    remainingPercent: 63,
    resetsAt: 1_700_400_000_000,
    windowSeconds: 604800,
  }])
})

test('parseCodexUsage returns undefined when windows are missing or malformed', () => {
  assert.equal(parseCodexUsage({}), undefined)
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 'x' } } }), undefined)
  assert.equal(parseCodexUsage(null), undefined)
})

test('parseGrokUsage reads weekly percent and period end', () => {
  const windows = parseGrokUsage({
    config: {
      creditUsagePercent: 34,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-06-01T00:00:00Z',
        end: '2026-06-08T00:00:00Z',
      },
    },
    raw_token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
  }, NOW)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].id, 'weekly')
  assert.equal(windows[0].usedPercent, 34)
  assert.equal(windows[0].remainingPercent, 66)
  assert.equal(windows[0].windowSeconds, 604800)
  assert.equal(windows[0].resetsAt, Date.parse('2026-06-08T00:00:00Z'))
})

test('parseGrokUsage keeps percent when the period is absent', () => {
  const windows = parseGrokUsage({ creditUsagePercent: 10 }, NOW)
  assert.deepEqual(windows, [{
    id: 'weekly',
    usedPercent: 10,
    remainingPercent: 90,
    windowSeconds: 604800,
  }])
})

test('sanitizeUsage drops secrets and unknown fields', () => {
  const sanitized = sanitizeUsage({
    provider: 'openai-codex',
    available: true,
    windows: [{ id: 'weekly', usedPercent: 10, remainingPercent: 90, accountId: 'acct_secret' }],
    fetchedAt: NOW,
    accessToken: 'sk-leaked',
    error: { code: 'USAGE_UNAVAILABLE', message: 'Usage is temporarily unavailable', body: 'upstream boom' },
  })
  const serialized = JSON.stringify(sanitized)
  assert.equal(serialized.includes('sk-leaked'), false)
  assert.equal(serialized.includes('acct_secret'), false)
  assert.equal(serialized.includes('upstream boom'), false)
  assert.deepEqual(sanitized, {
    provider: 'openai-codex',
    available: true,
    windows: [{ id: 'weekly', usedPercent: 10, remainingPercent: 90 }],
    fetchedAt: NOW,
    error: { code: 'USAGE_UNAVAILABLE', message: 'Usage is temporarily unavailable' },
  })
})

test('createUsageService skips unconfigured providers and caches a successful fetch', async () => {
  let calls = 0
  const service = createUsageService({
    auth: {
      configured: provider => provider === 'openai-codex',
      resolveOAuth: async () => ({ apiKey: 'tok', headers: { 'chatgpt-account-id': 'acct' } }),
    },
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: {
            secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1_700_086_400 },
          },
        }),
      }
    },
  })

  const first = await service.fetchAll()
  const second = await service.fetchAll()
  assert.equal(calls, 1)
  assert.equal(first[0].available, true)
  assert.equal(first[0].windows[0].remainingPercent, 88)
  assert.equal(first[1].available, false)
  assert.deepEqual(second[0], first[0])
  const serialized = JSON.stringify(first)
  assert.equal(serialized.includes('tok'), false)
  assert.equal(serialized.includes('acct'), false)
})

test('createUsageService refresh bypasses the cache', async () => {
  let calls = 0
  const service = createUsageService({
    auth: {
      configured: provider => provider === 'xai',
      resolveOAuth: async () => ({ apiKey: 'grok-tok' }),
    },
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ config: { creditUsagePercent: calls === 1 ? 10 : 40 } }),
      }
    },
  })
  const first = await service.fetchProvider('xai')
  const cached = await service.fetchProvider('xai')
  const refreshed = await service.fetchProvider('xai', { refresh: true })
  assert.equal(calls, 2)
  assert.equal(first.windows[0].usedPercent, 10)
  assert.equal(cached.windows[0].usedPercent, 10)
  assert.equal(refreshed.windows[0].usedPercent, 40)
})

test('createUsageService keeps the last good snapshot when a later fetch fails', async () => {
  let calls = 0
  const service = createUsageService({
    auth: {
      configured: () => true,
      resolveOAuth: async () => ({ apiKey: 'tok' }),
    },
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ rate_limit: { secondary_window: { used_percent: 25 } } }),
        }
      }
      return { ok: false, status: 500, json: async () => ({ error: 'nope' }) }
    },
  })
  const ok = await service.fetchProvider('openai-codex')
  const failed = await service.fetchProvider('openai-codex', { refresh: true })
  assert.equal(ok.windows[0].usedPercent, 25)
  assert.equal(failed.stale, true)
  assert.equal(failed.windows[0].usedPercent, 25)
  assert.equal(failed.error.code, 'USAGE_UNAVAILABLE')
  assert.equal(JSON.stringify(failed).includes('nope'), false)
})

test('createUsageService maps 401 to USAGE_UNAUTHORIZED', async () => {
  const service = createUsageService({
    auth: {
      configured: () => true,
      resolveOAuth: async () => ({ apiKey: 'tok' }),
    },
    now: () => NOW,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  })
  const result = await service.fetchProvider('xai')
  assert.equal(result.error.code, 'USAGE_UNAUTHORIZED')
  assert.deepEqual(result.windows, [])
})

test('createUsageService logout clear drops the cached snapshot', async () => {
  let calls = 0
  const service = createUsageService({
    auth: {
      configured: () => true,
      resolveOAuth: async () => ({ apiKey: 'tok' }),
    },
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ config: { creditUsagePercent: 5 } }),
      }
    },
  })
  await service.fetchProvider('xai')
  service.clear('xai')
  await service.fetchProvider('xai')
  assert.equal(calls, 2)
})
