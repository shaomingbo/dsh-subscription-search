import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let plugin
  const React = {
    createElement(type, props, ...children) {
      return typeof type === 'function' ? type(props ?? {}) : { type, props, children }
    },
    useState(initial) { return [initial, () => {}] },
    useEffect(effect) { effect() },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load({ factory }) {
      plugin = factory((name) => { assert.equal(name, 'react'); return React })
    } } },
  })
  return plugin
}

test('search client prefers /api/subscription-search/* then falls back to the generic channel', async () => {
  const plugin = loadClient()
  const calls = []
  const connection = {
    rpc: {
      async call(channel, endpoint) {
        calls.push({ channel, endpoint, urlPath: `${channel}/${endpoint}` })
        if (channel === '/api') return { ok: true, value: { settings: { order: [], enabled: {} }, backends: [], diagnostics: [] } }
        throw new Error('legacy should not run when /api succeeds')
      },
    },
  }
  plugin.apply({
    connection,
    slots: { inject(_name, callback) { callback() }, register(_descriptor, component) { component({ connection }) } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls[0].urlPath, '/api/subscription-search/status')
})

test('search client falls back to /subscription-search when /api transport fails', async () => {
  const plugin = loadClient()
  const calls = []
  const connection = {
    rpc: {
      async call(channel, endpoint) {
        calls.push({ channel, endpoint, urlPath: `${channel}/${endpoint}` })
        if (channel === '/api') throw new Error('transport failure HTTP 404')
        return { ok: true, value: { settings: { order: [], enabled: {} }, backends: [], diagnostics: [] } }
      },
    },
  }
  plugin.apply({
    connection,
    slots: { inject(_name, callback) { callback() }, register(_descriptor, component) { component({ connection }) } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls.map((row) => row.urlPath), ['/api/subscription-search/status', '/subscription-search/status'])
})
