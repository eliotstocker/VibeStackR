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
const { loadConfig } = require('../lib/config')
const { createEngine } = require('../lib/engine')
const { createUI } = require('../lib/ui')
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

test('Sub-Stacks: Deep Multi-Tier Nested Config Resolution & Path Rewriting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-sub-deep-'))
  try {
    const dbDir = path.join(root, 'infra', 'db')
    const backendDir = path.join(root, 'services', 'backend')
    fs.mkdirSync(dbDir, { recursive: true })
    fs.mkdirSync(backendDir, { recursive: true })

    // Tier 3: db sub-stack
    fs.writeFileSync(
      path.join(dbDir, '.vibestackr.json'),
      JSON.stringify({
        services: [
          { name: 'postgres', command: 'echo postgres', cwd: './data', envFile: '.env.db' },
          { name: 'redis', command: 'echo redis' },
        ],
      })
    )

    // Tier 2: backend sub-stack (imports db sub-stack)
    fs.writeFileSync(
      path.join(backendDir, '.vibestackr.json'),
      JSON.stringify({
        services: [
          { name: 'db', config: '../../infra/db', only: ['postgres'] },
          { name: 'api', command: 'echo api', cwd: './src', dependsOn: ['db/postgres'] },
        ],
        dependencies: [{ message: 'need node', when: [{ commandMissing: 'node-missing-test' }] }],
        shortcuts: [{ key: 'b', label: 'restart api', restart: 'api' }],
      })
    )

    // Tier 1: root config (imports backend sub-stack)
    fs.writeFileSync(
      path.join(root, '.vibestackr.json'),
      JSON.stringify({
        services: [
          { name: 'srv', config: './services/backend', env: { GLOBAL_ENV: 'true' } },
          { name: 'gateway', command: 'echo gateway', dependsOn: ['srv/api'] },
        ],
      })
    )

    const { config } = loadConfig(root)
    assert.equal(config.services.length, 3)

    // Verify deep nested namespacing and grouping
    const pg = config.services.find((s) => s.name === 'db/postgres')
    assert.ok(pg, 'db/postgres should exist')
    assert.equal(pg.group, 'srv/db')
    assert.equal(pg.cwd, path.normalize('infra/db/data'))
    assert.equal(pg.envFile, path.normalize('infra/db/.env.db'))
    assert.equal(pg.env.GLOBAL_ENV, 'true')

    const api = config.services.find((s) => s.name === 'srv/api')
    assert.ok(api, 'srv/api should exist')
    assert.equal(api.group, 'srv')
    assert.equal(api.cwd, path.normalize('services/backend/src'))
    assert.deepEqual(api.dependsOn, ['srv/db/postgres'])

    const gw = config.services.find((s) => s.name === 'gateway')
    assert.ok(gw, 'gateway should exist')
    assert.deepEqual(gw.dependsOn, ['srv/api'])

    // Verify inherited dependencies & shortcuts
    assert.equal(config.dependencies.length, 1)
    assert.equal(config.dependencies[0].message, '[srv] need node')
    assert.equal(config.shortcuts.length, 1)
    assert.equal(config.shortcuts[0].restart, 'srv/api')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Sub-Stacks: End-to-End Daemon, Control Socket & Log Tailing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-sub-daemon-'))
  try {
    const subDir = path.join(root, 'sub')
    fs.mkdirSync(subDir, { recursive: true })

    fs.writeFileSync(
      path.join(subDir, '.vibestackr.json'),
      JSON.stringify({
        services: [
          { name: 'worker', command: 'sh', args: ['-c', 'echo worker-sub-log; sleep 30'] },
        ],
      })
    )

    fs.writeFileSync(
      path.join(root, '.vibestackr.json'),
      JSON.stringify({
        services: [
          { name: 'auth', config: './sub' },
          { name: 'web', command: 'sh', args: ['-c', 'echo web-root-log; sleep 30'] },
        ],
        shortcuts: [
          { key: 'x', label: 'echo-test', command: 'echo shortcut-exec' },
        ],
      })
    )

    // 1. Start daemon in background with --persist-logs
    const bgRes = await runToCompletion(['--background', '--persist-logs'], root)
    assert.equal(bgRes.code, 0, `background daemon failed: ${bgRes.stderr}`)

    // 2. Attach client over socket and verify service metadata
    const servicesRes = await requestSocket(root, 'services', {})
    const services = servicesRes.services
    const worker = services.find((s) => s.name === 'auth/worker')
    assert.ok(worker)
    assert.equal(worker.included, true)

    // 3. Attach client polling feeds sub-stack log lines into UI
    const capturedLogs = []
    const mockUI = { write(tab, line) { if (tab === 'auth/worker') capturedLogs.push(line) }, refreshStatus() {}, destroy() {} }
    const attach = createAttachClient({ config: { services: [{ name: 'auth/worker' }, { name: 'web' }] }, root })
    await attach.init()
    attach.setUI(mockUI)
    await waitUntil(async () => {
      await attach.pollOnce()
      return capturedLogs.some((l) => l.includes('worker-sub-log'))
    })
    attach.detach()

    // 4. Poll log tailing for sub-stack service over socket
    await waitUntil(async () => {
      const tail = await requestSocket(root, 'tail', { name: 'auth/worker', since: 0 })
      return tail.lines && tail.lines.some((l) => l.includes('worker-sub-log'))
    })

    // 5. Verify persisted log file on disk for sub-stack service (logs/auth/worker.log)
    const logFilePath = path.join(root, 'logs', 'auth', 'worker.log')
    await waitUntil(() => fs.existsSync(logFilePath))
    assert.ok(fs.readFileSync(logFilePath, 'utf8').includes('worker-sub-log'))

    // 6. Restart sub-stack service over socket
    const restartRes = await requestSocket(root, 'restart', { name: 'auth/worker' })
    assert.ok(restartRes.status != null)
  } finally {
    try { await stopDaemon(root) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Sub-Stacks: MCP Tools Integration (get_services, list_scripts, restart_service)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-sub-mcp-'))
  const subDir = path.join(root, 'services', 'api')
  fs.mkdirSync(subDir, { recursive: true })

  fs.writeFileSync(
    path.join(subDir, '.vibestackr.json'),
    JSON.stringify({
      services: [
        { name: 'server', cwd: subDir, command: 'sh', args: ['-c', 'echo sub-api-started; sleep 30'] },
      ],
    })
  )
  fs.writeFileSync(path.join(subDir, 'package.json'), JSON.stringify({ scripts: { seed: 'echo sub-seed-ok' } }))

  fs.writeFileSync(
    path.join(root, '.vibestackr.json'),
    JSON.stringify({
      services: [
        { name: 'backend', config: './services/api' },
      ],
      shortcuts: [
        { key: 'r', label: 'restart-api', restart: 'backend/server' },
      ],
    })
  )

  const transport = new StdioClientTransport({ command: 'node', args: [BIN, 'mcp'], cwd: root })
  const client = new Client({ name: 'sub-stack-mcp-test', version: '1.0.0' })
  await client.connect(transport)

  try {
    // 1. Start daemon via MCP
    const startRes = await client.callTool({ name: 'start_daemon', arguments: {} })
    assert.equal(JSON.parse(startRes.content[0].text).ok, true)

    // 2. Query services via MCP and verify sub-stack namespacing
    const servicesRes = await client.callTool({ name: 'get_services', arguments: {} })
    const services = JSON.parse(servicesRes.content[0].text).services
    const serverSvc = services.find((s) => s.name === 'backend/server')
    assert.ok(serverSvc)

    // 3. Discover and run job scripts in sub-stack
    const listScriptsRes = await client.callTool({ name: 'list_scripts', arguments: { service: 'backend/server' } })
    const scripts = JSON.parse(listScriptsRes.content[0].text).jobs
    assert.ok(scripts.some((j) => j.id === 'npm:seed'))

    const runScriptRes = await client.callTool({ name: 'run_script', arguments: { service: 'backend/server', script: 'npm:seed' } })
    const jobTab = JSON.parse(runScriptRes.content[0].text).tab
    assert.ok(jobTab.startsWith('job:backend/server:npm:seed:'))

    await waitUntil(async () => {
      const logsRes = await client.callTool({ name: 'get_logs', arguments: { name: jobTab } })
      const lines = JSON.parse(logsRes.content[0].text).lines
      return lines && lines.some((l) => l.includes('sub-seed-ok'))
    })

    // 4. Restart sub-stack service via MCP
    const restartRes = await client.callTool({ name: 'restart_service', arguments: { name: 'backend/server' } })
    assert.ok(JSON.parse(restartRes.content[0].text).status != null)

    // 5. Stop daemon via MCP
    const stopRes = await client.callTool({ name: 'stop_daemon', arguments: {} })
    assert.equal(JSON.parse(stopRes.content[0].text).ok, true)
  } finally {
    await client.close().catch(() => {})
    try { if (transport && transport._process) transport._process.kill('SIGTERM') } catch {}
    try {
      const { isSocketAlive, socketPath } = require('../lib/control-socket')
      if (await isSocketAlive(socketPath(root))) await stopDaemon(root)
    } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Sub-Stacks: UI Tab Grouping and Render Handling', () => {
  const config = {
    services: [
      { name: 'auth/db', command: 'true', group: 'auth' },
      { name: 'auth/api', command: 'true', group: 'auth' },
      { name: 'frontend', command: 'true' },
    ],
    shortcuts: [],
  }

  const engine = createEngine({
    config,
    args: { exclude: new Set(), only: new Set(), serviceLog: '', persistLogs: false },
  })

  // Verify blessed UI initializes tab structure without throwing for grouped services
  let ui
  assert.doesNotThrow(() => {
    ui = createUI({
      config,
      engine,
      onQuit: () => {},
      onDetach: () => {},
      onReloadConfig: () => {},
      version: '1.0.0',
    })
  })

  assert.ok(ui)
  assert.doesNotThrow(() => ui.destroy())
})
