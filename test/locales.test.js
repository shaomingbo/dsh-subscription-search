import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')

test('search settings ships localized chain/status/diagnostics and Accounts & Usage direction', () => {
  for (const phrase of ['网页搜索', '搜索链', '最近诊断', '账户与用量', 'Web Search', 'Search chain', 'Recent diagnostics', 'Accounts & Usage']) {
    assert.match(client, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(client, /locale\.register/)
  assert.match(client, /inject = \['slots', 'connection'\]/)
})

test('active client composition contains no OAuth, subscription cards, quota dock, or credential input', () => {
  for (const forbidden of [
    'start-login', 'login-status', 'cancel-login', "'usage'", 'SubscriptionCard', 'UsageDock',
    'conversation.composer.dock', 'credentials.set', 'type: \'password\'', 'EXA_API_KEY', 'DEEPSEEK_API_KEY',
  ]) assert.equal(client.includes(forbidden), false, `legacy client composition remains: ${forbidden}`)
})
