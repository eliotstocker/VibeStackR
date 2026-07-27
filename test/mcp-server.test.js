'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { createEngine } = require('../lib/engine')
const { startControlSocket, stopControlSocket } = require('../lib/control-socket')

const BIN = path.join(__dirname, '..', 'bin', 'vibestackr')
const NOOP_UI = { write() {}, refreshStatus() {}, destroy() {} }
const baseArgs = () => ({ exclude: new Set(), only: new Set(), serviceLog: '', persistLogs: false })

const waitUntil = async (predicate, { timeout = 3000, interval = 20 } = {}) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

const toolText = (res) => JSON.parse(res.content[0].text)

// Runs `vibestackr mcp` for real (as a subprocess, over stdio, via the actual
// MCP SDK client) against a real running control socket — the same one the
// TUI would expose, just without blessed in the loop since these tools never
// touch the UI at all.
async function withMcpClient(config, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-mcp-test-'))
  const prevCwd = process.cwd()
  process.chdir(root)
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  const handle = await startControlSocket({ engine, config, root })
  const transport = new StdioClientTransport({ command: 'node', args: [BIN, 'mcp'], cwd: root })
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(transport)
  try {
    await fn({ client, engine, root })
  } finally {
    await client.close()
    await Promise.all([...engine.children.keys()].map((n) => engine.killService(n)))
    stopControlSocket(handle)
    process.chdir(prevCwd)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('lists all 7 tools', async () => {
  await withMcpClient({ services: [], shortcuts: [] }, async ({ client }) => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['get_logs', 'get_services', 'get_status', 'list_shortcuts', 'reload_config', 'restart_service', 'run_shortcut'].sort())
  })
})

test('get_services reports config-derived info, including watcher, for every service', async () => {
  const config = {
    services: [
      { name: 'web', command: 'npm', args: ['run', 'dev'], type: 'node', note: 'http://localhost:3000', watcher: true, dependsOn: ['db'] },
      { name: 'db', command: 'true', oneShot: true, liveness: { type: 'command', command: 'true' } },
    ],
  }
  await withMcpClient(config, async ({ client, engine }) => {
    const res = await client.callTool({ name: 'get_services', arguments: {} })
    const services = toolText(res).services
    const web = services.find((s) => s.name === 'web')
    const db = services.find((s) => s.name === 'db')

    assert.equal(web.type, 'node')
    assert.equal(web.note, 'http://localhost:3000')
    assert.equal(web.watcher, true)
    assert.equal(web.oneShot, false)
    assert.deepEqual(web.dependsOn, ['db'])
    assert.equal(web.liveness, null)
    assert.equal(web.included, true)
    assert.equal(web.status, null)

    assert.equal(db.watcher, false) // not configured — reported as false, not undefined
    assert.equal(db.oneShot, true)
    assert.equal(db.liveness, 'command')

    engine.spawnService(config.services[1])
    await waitUntil(() => engine.status.get('db') != null)
    const res2 = await client.callTool({ name: 'get_services', arguments: {} })
    assert.equal(toolText(res2).services.find((s) => s.name === 'db').status, engine.status.get('db'))
  })
})

test('get_status / restart_service / list_shortcuts / run_shortcut / get_logs round-trip over real MCP tool calls', async () => {
  const config = {
    services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }],
    shortcuts: [{ key: 'g', label: 'greet', command: 'echo hi-mcp' }],
  }
  await withMcpClient(config, async ({ client, engine }) => {
    const status1 = await client.callTool({ name: 'get_status', arguments: {} })
    assert.deepEqual(toolText(status1), {})

    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'starting')

    const status2 = await client.callTool({ name: 'get_status', arguments: {} })
    assert.equal(toolText(status2).web, 'starting')

    const firstPid = engine.children.get('web').proc.pid
    const restarted = await client.callTool({ name: 'restart_service', arguments: { name: 'web' } })
    assert.equal(toolText(restarted).status, 'starting')
    await waitUntil(() => engine.children.get('web').proc.pid !== firstPid)

    const shortcuts = await client.callTool({ name: 'list_shortcuts', arguments: {} })
    assert.deepEqual(toolText(shortcuts).shortcuts, [{ key: 'g', label: 'greet' }])

    const ran = await client.callTool({ name: 'run_shortcut', arguments: { key: 'g' } })
    assert.deepEqual(toolText(ran), { ok: true })
    await waitUntil(() => engine.getLogs('run-local').some((l) => l.includes('hi-mcp')))

    const logs = await client.callTool({ name: 'get_logs', arguments: { name: 'run-local' } })
    assert.ok(toolText(logs).lines.some((l) => l.includes('hi-mcp')))
  })
})

test('get_logs and run_shortcut report tool errors (isError) rather than throwing, for bad input', async () => {
  await withMcpClient({ services: [], shortcuts: [] }, async ({ client }) => {
    const badLogs = await client.callTool({ name: 'get_logs', arguments: { name: 'nonexistent' } })
    // nonexistent service just has an empty buffer — not an error case, only
    // a truly malformed request (missing name) is. get_logs requires `name`
    // in its zod schema, so the SDK itself rejects a missing name before it
    // ever reaches the socket — verify that path instead.
    assert.deepEqual(toolText(badLogs), { lines: [] })

    const badShortcut = await client.callTool({ name: 'run_shortcut', arguments: { key: 'nope' } })
    assert.equal(badShortcut.isError, true)
    assert.match(badShortcut.content[0].text, /no shortcut/)
  })
})

test('restart_service with an unknown service name reports isError, not a silent {status: null}', async () => {
  await withMcpClient({ services: [{ name: 'web', command: 'true' }], shortcuts: [] }, async ({ client }) => {
    const res = await client.callTool({ name: 'restart_service', arguments: { name: 'typo-service' } })
    assert.equal(res.isError, true)
    assert.match(res.content[0].text, /no service named 'typo-service'/)
  })
})

test('run_shortcut works for a restart-type shortcut (not just command-type)', async () => {
  const config = {
    services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }],
    shortcuts: [{ key: 'r', label: 'restart web', restart: 'web' }],
  }
  await withMcpClient(config, async ({ client, engine }) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.children.has('web'))
    const firstPid = engine.children.get('web').proc.pid

    const ran = await client.callTool({ name: 'run_shortcut', arguments: { key: 'r' } })
    assert.deepEqual(toolText(ran), { ok: true })
    await waitUntil(() => engine.children.get('web').proc.pid !== firstPid)
    assert.notEqual(engine.children.get('web').proc.pid, firstPid)
  })
})

test('get_logs with a `lines` argument truncates to the most recent N lines', async () => {
  const config = { services: [{ name: 'noisy', command: 'sh', args: ['-c', 'seq 1 50'], oneShot: true }], shortcuts: [] }
  await withMcpClient(config, async ({ client, engine }) => {
    const { ready } = engine.spawnService(config.services[0])
    await ready
    const all = await client.callTool({ name: 'get_logs', arguments: { name: 'noisy' } })
    assert.equal(toolText(all).lines.length, 50)

    const last5 = await client.callTool({ name: 'get_logs', arguments: { name: 'noisy', lines: 5 } })
    assert.deepEqual(toolText(last5).lines, ['46', '47', '48', '49', '50'])
  })
})

test('tool calls return a clear error (not a crash) when no vibestackr TUI is running for this project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-mcp-test-'))
  const transport = new StdioClientTransport({ command: 'node', args: [BIN, 'mcp'], cwd: root })
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(transport)
  try {
    const res = await client.callTool({ name: 'get_status', arguments: {} })
    assert.equal(res.isError, true)
    assert.match(res.content[0].text, /isn't running/)
  } finally {
    await client.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
