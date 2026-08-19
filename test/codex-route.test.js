import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openaiCodexRoutePatch } from '../lib/index.js'

test('openai-codex route always names the synced access-token credential', () => {
  assert.deepEqual(openaiCodexRoutePatch(undefined), {
    displayName: 'OpenAI Codex (ChatGPT subscription)',
    apiKeyEnv: 'OPENAI_CODEX_ACCESS_TOKEN',
  })
  assert.deepEqual(openaiCodexRoutePatch({ displayName: 'OpenAI Codex (ChatGPT subscription)' }), {
    displayName: 'OpenAI Codex (ChatGPT subscription)',
    apiKeyEnv: 'OPENAI_CODEX_ACCESS_TOKEN',
  })
})
