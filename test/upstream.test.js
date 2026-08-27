import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { SubscriptionAuthRuntime, describeUpstreamFailure } = await import('../lib/auth-runtime.js')

const REGION_403 = 'OpenAI Codex device code request failed with status 403: '
  + '{"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported","type":"request_forbidden"}}'

function connectError(code) {
  const error = new TypeError('fetch failed')
  error.cause = Object.assign(new Error(`something ${code}`), { code })
  return error
}

test('the region-denied upstream maps to the actionable proxy guidance', () => {
  const description = describeUpstreamFailure(new Error(REGION_403))
  assert.match(description, /unsupported_country_region_territory/)
  assert.match(description, /NODE_USE_ENV_PROXY=1 npx @deepseek-ai\/dsh web/)
})

test('transport-level fetch failures name their layer and the same remedy', () => {
  for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT']) {
    const description = describeUpstreamFailure(connectError(code))
    assert.match(description, new RegExp(code))
    assert.match(description, /NODE_USE_ENV_PROXY=1/)
    assert.doesNotMatch(description, /upstream: /)
  }
})

test('rate limiting during usercode/token steps says to back off', () => {
  assert.match(describeUpstreamFailure(new Error('OpenAI Codex device code request failed with status 429')), /wait a moment and retry/)
  assert.match(describeUpstreamFailure(new Error('authorization_pending vs slow_down handling broke')), /slow_down|wait a moment and retry/)
})

test('a Cloudflare-style bot 403 stays a factual upstream snippet, not proxy advice', () => {
  const description = describeUpstreamFailure(new Error('OpenAI Codex device code request failed with status 403: <!doctype html>Just a moment…'))
  assert.match(description, /^upstream: /)
  assert.match(description, /status 403/)
  assert.doesNotMatch(description, /NODE_USE_ENV_PROXY/)
})

test('long upstream bodies are truncated for the wire message', () => {
  const bloated = `OpenAI Codex device code request failed with status 400: ${'x'.repeat(5000)}TAIL-MARKER`
  const description = describeUpstreamFailure(bloated && new Error(bloated))
  assert.ok(description.length <= 310, `expected <=310 chars, got ${description.length}`)
  assert.ok(!description.includes('TAIL-MARKER'))
})

function makeRuntime(loggerCalls, filename = '/tmp/nonexistent-oauth.json') {
  const logger = { warn: (...args) => loggerCalls.push(args) }
  return new SubscriptionAuthRuntime({ filename, logger })
}

async function failLoginWith(runtime) {
  return runtime.startLogin('openai-codex').then(
    value => ({ settled: 'resolved', value }),
    error => ({ settled: 'rejected', error }),
  )
}

test('failures before the challenge publishs reject with the actionable copy and log the stack', async () => {
  const calls = []
  const runtime = makeRuntime(calls)
  runtime.models.login = async () => {
    throw new Error(REGION_403)
  }

  const outcome = await failLoginWith(runtime)

  assert.equal(outcome.settled, 'rejected')
  assert.equal(outcome.error.code, 'PI_AI_AUTH_LOGIN_FAILED')
  assert.match(outcome.error.message, /^ChatGPT Plus\/Pro sign-in failed:/)
  assert.match(outcome.error.message, /NODE_USE_ENV_PROXY=1/)

  const loginWarnings = calls.filter(args => args[1] === 'openai-codex' && args[2] === 'login')
  assert.equal(loginWarnings.length, 1)
  assert.match(String(loginWarnings[0][3]), /status 403/)
  assert.match(String(loginWarnings[0][3]), /SubscriptionAuthError|Error/)
})

test('failures after the challenge publishs still land the enriched copy in login-status', async () => {
  const calls = []
  const runtime = makeRuntime(calls)
  runtime.models.login = async (_provider, _mode, interaction) => {
    interaction.notify({
      type: 'device_code',
      userCode: 'FAKE-CODE',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 5,
      expiresInSeconds: 600,
    })
    throw connectError('UND_ERR_CONNECT_TIMEOUT')
  }

  await failLoginWith(runtime)

  const loginId = runtime.providerLogins.get('openai-codex')
  const status = runtime.loginStatus(loginId)
  assert.equal(status.kind, 'failed')
  assert.match(status.message, /could not reach the auth endpoint \(UND_ERR_CONNECT_TIMEOUT\)/)
  assert.match(status.message, /NODE_USE_ENV_PROXY=1/)

  const loginWarnings = calls.filter(args => args[2] === 'login')
  assert.equal(loginWarnings.length, 1)
})

test('credential-resolution failures keep their ref while carrying the upstream detail', async () => {
  const calls = []
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'subsearch-upstream-')), '.oauth.json')
  fs.writeFileSync(filename, JSON.stringify({
    version: 1,
    credentials: {
      'openai-codex': { type: 'oauth', access: 'a'.repeat(8), refresh: 'r'.repeat(8), expires: Date.now() + 3_600_000 },
    },
  }))
  const runtime = makeRuntime(calls, filename)
  await runtime.init()
  runtime.models.getAuth = async () => {
    throw new Error('OpenAI Codex getAuth blew up for diagnosis')
  }

  await assert.rejects(
    runtime.resolveOAuth('openai-codex'),
    error => {
      assert.equal(error.code, 'PI_AI_AUTH_RESOLUTION_FAILED')
      assert.deepEqual(error.details, { ref: 'OPENAI_CODEX_ACCESS_TOKEN' })
      assert.match(error.message, /upstream: OpenAI Codex getAuth blew up for diagnosis/)
      return true
    },
  )
  assert.ok(calls.some(args => args[2] === 'credential resolution'))
})
