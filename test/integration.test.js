'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { requestSocket, socketPath } = require('../lib/control-socket')
const { createAttachClient } = require('../lib/attach-client')

const BIN = path.join(__dirname, '..', 'bin', 'vibestackr')

const waitUntil = async (predicate, { timeout = 10000, interval = 30 } = {}) => {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function listenOnFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function runToCompletion(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

function stopDaemon(cwd) {
  return runToCompletion(['stop'], cwd)
}

test('Integration: Full Daemon Lifecycle & Client Attach Workflow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-int-daemon-'))
  const portServer = await listenOnFreePort()
  const port = portServer.address().port
  portServer.close()

  const config = {
    services: [
      { name: 'db', command: 'sh', args: ['-c', 'echo db-ready'], oneShot: true, liveness: { type: 'command', command: 'true' } },
      { name: 'api', command: 'node', args: ['-e', `
        const http = require('http');
        const server = http.createServer((req, res) => res.end('ok'));
        server.listen(${port}, '127.0.0.1');
      `], dependsOn: ['db'], liveness: { type: 'http', url: `http://127.0.0.1:${port}/` } },
      { name: 'frontend', command: 'sh', args: ['-c', 'echo frontend-starting; sleep 30'], dependsOn: ['api'] },
    ],
    shortcuts: [
      { key: 'p', label: 'ping', command: 'echo shortcut-ping-output' },
    ],
  }
  fs.writeFileSync(path.join(root, '.vibestackr.json'), JSON.stringify(config, null, 2))

  try {
    // 1. Start daemon in background
    const bgRes = await runToCompletion(['--background'], root)
    assert.equal(bgRes.code, 0, `daemon background failed: ${bgRes.stderr}`)

    const sock = socketPath(root)
    assert.ok(fs.existsSync(sock), `socket should exist at ${sock}`)

    // 2. Attach client over socket
    const attach = createAttachClient({ config, root })
    await attach.init()
    assert.equal(attach.included('db'), true)
    assert.equal(attach.included('api'), true)
    assert.equal(attach.included('frontend'), true)

    // 3. Poll until state settles (db ready -> api ready -> frontend starting)
    await waitUntil(async () => {
      await attach.pollOnce()
      return attach.status.get('db') === 'ready' &&
             attach.status.get('api') === 'ready' &&
             attach.status.get('frontend') === 'starting'
    })

    // 4. Trigger shortcut execution via control socket
    const ranShortcut = await requestSocket(root, 'run_shortcut', { key: 'p' })
    assert.deepEqual(ranShortcut, { ok: true })

    await waitUntil(async () => {
      const logsRes = await requestSocket(root, 'logs', { name: 'run-local' })
      return logsRes.lines && logsRes.lines.some((l) => l.includes('shortcut-ping-output'))
    })

    // 5. Verify tail cursor polling
    const tailRes1 = await requestSocket(root, 'tail', { name: 'run-local', since: 0 })
    assert.ok(tailRes1.lines.some((l) => l.includes('shortcut-ping-output')))
    assert.ok(tailRes1.total > 0)

    const tailRes2 = await requestSocket(root, 'tail', { name: 'run-local', since: tailRes1.total })
    assert.deepEqual(tailRes2.lines, [])
  } finally {
    try { await stopDaemon(root) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Integration: Full MCP Server End-to-End Workflow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-int-mcp-'))
  const config = {
    services: [
      { name: 'web', cwd: root, command: 'sh', args: ['-c', 'echo web-started; sleep 30'] },
    ],
    shortcuts: [
      { key: 'r', label: 'restart-web', restart: 'web' },
    ],
  }
  fs.writeFileSync(path.join(root, '.vibestackr.json'), JSON.stringify(config, null, 2))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'echo build-completed-ok' } }))

  const transport = new StdioClientTransport({ command: 'node', args: [BIN, 'mcp'], cwd: root })
  const client = new Client({ name: 'mcp-integration-test', version: '1.0.0' })
  await client.connect(transport)

  try {
    // 1. Call start_daemon via MCP
    const startRes = await client.callTool({ name: 'start_daemon', arguments: {} })
    const startText = JSON.parse(startRes.content[0].text)
    assert.equal(startText.ok, true)
    assert.ok(fs.existsSync(socketPath(root)))

    // 2. Discover and run background job
    const listScriptsRes = await client.callTool({ name: 'list_scripts', arguments: { service: 'web' } })
    const scripts = JSON.parse(listScriptsRes.content[0].text).jobs
    assert.ok(scripts.some((j) => j.id === 'npm:build'))

    const runScriptRes = await client.callTool({ name: 'run_script', arguments: { service: 'web', script: 'npm:build' } })
    const jobTab = JSON.parse(runScriptRes.content[0].text).tab
    assert.ok(jobTab.startsWith('job:web:npm:build:'))

    await waitUntil(async () => {
      const statusRes = await client.callTool({ name: 'get_job_status', arguments: { tab: jobTab } })
      return JSON.parse(statusRes.content[0].text).status === 'succeeded'
    })

    await waitUntil(async () => {
      const jobLogsRes = await client.callTool({ name: 'get_logs', arguments: { name: jobTab } })
      const lines = JSON.parse(jobLogsRes.content[0].text).lines
      return lines && lines.some((l) => l.includes('build-completed-ok'))
    })

    // 3. Live config reload via MCP
    const updatedConfig = {
      services: [
        { name: 'web', cwd: root, command: 'sh', args: ['-c', 'echo web-started; sleep 30'] },
        { name: 'worker', command: 'sh', args: ['-c', 'echo worker-started; sleep 30'] },
      ],
      shortcuts: [
        { key: 'h', label: 'hello', command: 'echo hello-world' },
      ],
    }
    fs.writeFileSync(path.join(root, '.vibestackr.json'), JSON.stringify(updatedConfig, null, 2))

    const reloadRes = await client.callTool({ name: 'reload_config', arguments: {} })
    assert.equal(JSON.parse(reloadRes.content[0].text).ok, true)

    const servicesRes = await client.callTool({ name: 'get_services', arguments: {} })
    const serviceNames = JSON.parse(servicesRes.content[0].text).services.map((s) => s.name)
    assert.ok(serviceNames.includes('worker'))

    const shortcutsRes = await client.callTool({ name: 'list_shortcuts', arguments: {} })
    const shortcutKeys = JSON.parse(shortcutsRes.content[0].text).shortcuts.map((s) => s.key)
    assert.ok(shortcutKeys.includes('h'))

    // 4. Restart service via MCP
    const restartRes = await client.callTool({ name: 'restart_service', arguments: { name: 'web' } })
    const restartData = JSON.parse(restartRes.content[0].text)
    assert.ok(restartData.status != null, `expected status in restart response, got ${JSON.stringify(restartData)}`)

    // 5. Stop daemon via MCP
    const stopRes = await client.callTool({ name: 'stop_daemon', arguments: {} })
    assert.equal(JSON.parse(stopRes.content[0].text).ok, true)

  } finally {
    await client.close().catch(() => {})
    try { if (transport && transport._process) transport._process.kill('SIGTERM') } catch {}
    try { await stopDaemon(root) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Integration: Multi-Project Concurrency & State Isolation', async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-int-projA-'))
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-int-projB-'))

  fs.writeFileSync(path.join(rootA, '.vibestackr.json'), JSON.stringify({
    services: [{ name: 'service-alpha', command: 'sh', args: ['-c', 'sleep 30'] }],
  }))
  fs.writeFileSync(path.join(rootB, '.vibestackr.json'), JSON.stringify({
    services: [{ name: 'service-beta', command: 'sh', args: ['-c', 'sleep 30'] }],
  }))

  try {
    // Launch daemon A and daemon B concurrently
    const [resA, resB] = await Promise.all([
      runToCompletion(['--background'], rootA),
      runToCompletion(['--background'], rootB),
    ])
    assert.equal(resA.code, 0)
    assert.equal(resB.code, 0)

    const sockA = socketPath(rootA)
    const sockB = socketPath(rootB)
    assert.notEqual(sockA, sockB)
    assert.ok(fs.existsSync(sockA))
    assert.ok(fs.existsSync(sockB))

    // Query both daemons and ensure zero cross-contamination
    const servicesA = await requestSocket(rootA, 'services', {})
    const servicesB = await requestSocket(rootB, 'services', {})

    const namesA = servicesA.services.map((s) => s.name)
    const namesB = servicesB.services.map((s) => s.name)

    assert.deepEqual(namesA, ['service-alpha'])
    assert.deepEqual(namesB, ['service-beta'])

    // Stop project A daemon only
    await stopDaemon(rootA)
    await waitUntil(() => !fs.existsSync(sockA))

    // Project B daemon must remain alive and responsive
    const servicesBStillAlive = await requestSocket(rootB, 'services', {})
    assert.deepEqual(servicesBStillAlive.services.map((s) => s.name), ['service-beta'])
  } finally {
    try { await stopDaemon(rootA) } catch {}
    try { await stopDaemon(rootB) } catch {}
    fs.rmSync(rootA, { recursive: true, force: true })
    fs.rmSync(rootB, { recursive: true, force: true })
  }
})

test('Integration: Stale Socket Cleanup & Auto Recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-int-stale-'))
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'] }] }
  fs.writeFileSync(path.join(root, '.vibestackr.json'), JSON.stringify(config))

  const sock = socketPath(root)
  fs.mkdirSync(path.dirname(sock), { recursive: true })
  // Simulate dead lingering socket file
  fs.writeFileSync(sock, '')

  try {
    assert.ok(fs.existsSync(sock))
    // Run --background daemon on top of stale socket file
    const res = await runToCompletion(['--background'], root)
    assert.equal(res.code, 0, `background failed to recover from stale socket: ${res.stderr}`)
    assert.ok(fs.existsSync(sock))

    // Confirm new socket responds correctly
    const statusRes = await requestSocket(root, 'status', {})
    assert.ok(statusRes != null)
  } finally {
    try { await stopDaemon(root) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Integration: High-Volume Log Streaming & Persist Logs File Integrity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-int-log-'))
  const count = 2000
  const config = {
    services: [
      { name: 'streamer', cwd: '.', command: 'sh', args: ['-c', `for i in $(seq 1 ${count}); do echo "LOG_LINE_$i"; done; sleep 30`] },
    ],
  }
  fs.writeFileSync(path.join(root, '.vibestackr.json'), JSON.stringify(config))

  try {
    // Run daemon with --persist-logs enabled
    const res = await runToCompletion(['--background', '--persist-logs'], root)
    assert.equal(res.code, 0)

    // Wait until stream finishes producing lines
    let lastTotal = 0
    await waitUntil(async () => {
      const tail = await requestSocket(root, 'tail', { name: 'streamer', since: 0 })
      lastTotal = tail.total
      return tail.total >= count
    })

    assert.equal(lastTotal, count)

    // Verify persisted log file on disk
    const logFilePath = path.join(root, 'logs', 'streamer.log')
    await waitUntil(() => fs.existsSync(logFilePath))
    const logFileContent = fs.readFileSync(logFilePath, 'utf8')
    const lines = logFileContent.trim().split('\n')
    assert.equal(lines.length, count)
    assert.equal(lines[0], 'LOG_LINE_1')
    assert.equal(lines[count - 1], `LOG_LINE_${count}`)
  } finally {
    try { await stopDaemon(root) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
})
