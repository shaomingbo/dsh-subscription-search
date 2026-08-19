import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
const srcClient = readFileSync(join(root, 'src/client.js'), 'utf8')

const CHINESE_CHROME = [
  '搜索',
  '网页搜索',
  '搜索链',
  '订阅搜索',
  '已连接',
  '未连接',
  '断开连接',
]

const HARDCODED_ENGLISH_CHROME = [
  "h('h2', null, 'Web Search')",
  "label: () => 'Search'",
]

test('search panel ships Chinese chrome for the default DSH locale', () => {
  for (const phrase of CHINESE_CHROME) {
    assert.match(client, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing Chinese chrome: ${phrase}`)
  }
})

test('search panel binds DSH locale instead of hardcoding English titles', () => {
  assert.match(client, /locale\.register/)
  assert.match(client, /inject = \['slots', 'connection'\]/)
  assert.equal(client.includes("inject = ['slots', 'connection', 'locale']"), false)
  for (const snippet of HARDCODED_ENGLISH_CHROME) {
    assert.equal(client.includes(snippet), false, `hardcoded English chrome still present: ${snippet}`)
  }
})

test('src and lib client copies stay in sync', () => {
  assert.equal(srcClient, client)
})
