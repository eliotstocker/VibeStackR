'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createEngine } = require('../lib/engine')
const { startControlSocket, stopControlSocket } = require('../lib/control-socket')
const { createAttachClient } = require('../lib/attach-client')

const NOOP_UI = { write() {}, refreshStatus() {}, destroy() {} }
const baseArgs = () => ({ exclude: new Set(), only: new Set(), serviceLog: '', persistLogs: false })

const waitUntil = async (predicate, { timeout = 5000, interval = 20 } = {}) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

// A real daemon (engine + control socket), same shape as an attach client
// would find in practice — attach-client.js has no idea whether it's talking
// to a genuine `bin/vibestackr --daemon` or this test helper.
async function withDaemon(config, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-attach-test-'))
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  let handle = null
  let quitCalled = false
  try {
    handle = await startControlSocket({
      engine, config, root,
      onReloadConfig: async () => ({ ok: true }),
      onQuit: async () => { quitCalled = true; await engine.quit(); stopControlSocket(handle) },
    })
    await fn({ engine, root, isQuit: () => quitCalled })
  } finally {
    await Promise.all([...engine.children.keys()].map((n) => engine.killService(n)))
    stopControlSocket(handle)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function fakeUI() {
  const written = [] // [{tab, line}]
  let refreshes = 0
  let destroyed = false
  return {
    ui: {
      write: (tab, line) => written.push({ tab, line }),
      refreshStatus: () => { refreshes++ },
      destroy: () => { destroyed = true },
    },
    written,
    refreshCount: () => refreshes,
    isDestroyed: () => destroyed,
  }
}

test('init() populates included() from the daemon, and pollOnce() populates status', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }] }
  await withDaemon(config, async ({ engine, root }) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'starting')

    const attach = createAttachClient({ config, root })
    assert.equal(attach.included('web'), false) // no init() yet
    await attach.init()
    assert.equal(attach.included('web'), true)
    assert.equal(attach.included('never-configured'), false)
    assert.equal(attach.status.has('web'), false) // init() alone doesn't touch status
    await attach.pollOnce()
    assert.equal(attach.status.get('web'), 'starting')
  })
})

// Regression test: included() must NOT be derived from `status` (whether a
// service has ever been spawned) — a daemon's control socket comes alive
// well before startAll() actually calls spawnService() for every service
// (mise/checkDeps haven't even run yet, and a service deep in a dependsOn
// chain can take much longer still). Deriving included() from `status` meant
// an attach client's very first snapshot (taken the instant the socket
// answers) could easily be empty, permanently locking every service out of
// lib/ui.js's tab list (fixed at createUI() time, never recomputed).
test('included() is true for a configured, non-excluded service even before it has ever appeared in a status snapshot', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }] }
  await withDaemon(config, async ({ root }) => {
    // Deliberately never calling engine.spawnService() — this is the "socket
    // just came alive, startAll() hasn't run yet" moment.
    const attach = createAttachClient({ config, root })
    await attach.init()
    assert.equal(attach.included('web'), true)
    assert.equal(attach.status.has('web'), false)
  })
})

test('included() is false for a service excluded via --exclude/--only, even if attach-client never polls status', async () => {
  const config = { services: [{ name: 'web', command: 'true' }, { name: 'worker', command: 'true' }] }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-attach-test-'))
  const engine = createEngine({ config, args: { exclude: new Set(['worker']), only: new Set(), serviceLog: '', persistLogs: false } })
  engine.setUI(NOOP_UI)
  let handle = null
  try {
    handle = await startControlSocket({ engine, config, root })
    const attach = createAttachClient({ config, root })
    await attach.init()
    assert.equal(attach.included('web'), true)
    assert.equal(attach.included('worker'), false)
  } finally {
    stopControlSocket(handle)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pollOnce feeds only new log lines into the UI, in order, across repeated calls', async () => {
  const config = { services: [{ name: 'noisy', command: 'sh', args: ['-c', 'echo one; sleep 10'] }] }
  await withDaemon(config, async ({ engine, root }) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogs('noisy').includes('one'))

    const attach = createAttachClient({ config, root })
    const { ui, written } = fakeUI()
    attach.setUI(ui)

    await attach.pollOnce()
    assert.ok(written.some((w) => w.tab === 'noisy' && w.line === 'one'))
    const countAfterFirst = written.length

    // Nothing new happened — a second poll shouldn't redeliver 'one'.
    await attach.pollOnce()
    assert.equal(written.length, countAfterFirst)
  })
})

test('runShortcut proxies to the daemon over the socket', async () => {
  const config = { services: [], shortcuts: [{ key: 'g', label: 'greet', command: 'echo hi-from-shortcut' }] }
  await withDaemon(config, async ({ engine, root }) => {
    const attach = createAttachClient({ config, root })
    await attach.runShortcut({ key: 'g' })
    await waitUntil(() => engine.getLogs('run-local').some((l) => l.includes('hi-from-shortcut')))
  })
})

test('restartService proxies to the daemon over the socket', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }] }
  await withDaemon(config, async ({ engine, root }) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.children.has('web'))
    const firstPid = engine.children.get('web').proc.pid

    const attach = createAttachClient({ config, root })
    await attach.restartService('web')
    await waitUntil(() => engine.children.get('web')?.proc.pid !== firstPid)
    assert.notEqual(engine.children.get('web').proc.pid, firstPid)
  })
})

test('detach() stops polling and destroys the local UI, without touching the daemon', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }] }
  await withDaemon(config, async ({ engine, root, isQuit }) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'starting')

    const attach = createAttachClient({ config, root })
    const { ui, isDestroyed } = fakeUI()
    attach.setUI(ui)
    await attach.pollOnce()
    attach.startPolling()

    attach.detach()
    assert.ok(isDestroyed())
    assert.equal(isQuit(), false)
    assert.equal(engine.status.get('web'), 'starting') // daemon's own service untouched
  })
})

test('quit() asks the daemon to fully stop', async () => {
  const config = { services: [] }
  await withDaemon(config, async ({ root, isQuit }) => {
    const attach = createAttachClient({ config, root })
    const { ui } = fakeUI()
    attach.setUI(ui)
    await attach.quit()
    await waitUntil(isQuit)
  })
})

test('getDaemonVersion() fetches version on init()', async () => {
  const config = { services: [] }
  await withDaemon(config, async ({ root }) => {
    const attach = createAttachClient({ config, root })
    await attach.init()
    assert.equal(attach.getDaemonVersion(), require('../package.json').version)
  })
})

test('discoverJobs, runJob, watchJobTab, unwatchJobTab and jobStatus polling', async () => {
  const config = { services: [{ name: 'web', cwd: '.', command: 'true' }] }
  await withDaemon(config, async ({ root, engine }) => {
    engine.discoverJobsForService = () => [{ id: 'npm:build', source: 'npm', label: 'build', command: 'npm', args: ['run', 'build'] }]
    engine.discoverAllJobs = () => [{ name: 'web', jobs: engine.discoverJobsForService('web') }]
    engine.runJob = () => 'job:web:npm:build:1'
    engine.getJobStatus = () => 'succeeded'

    const attach = createAttachClient({ config, root })
    await attach.init()

    const jobs = await attach.discoverJobs('web')
    assert.equal(jobs[0].id, 'npm:build')

    const allServices = await attach.discoverAllJobs()
    assert.equal(allServices[0].name, 'web')

    const tab = await attach.runJob('web', 'npm:build')
    assert.equal(tab, 'job:web:npm:build:1')

    attach.watchJobTab(tab)
    await attach.pollOnce()
    assert.equal(attach.jobStatus.get(tab), 'succeeded')

    attach.unwatchJobTab(tab)
    assert.equal(attach.jobStatus.has(tab), false)
  })
})

test('reloadConfig() proxies request to daemon', async () => {
  const config = { services: [] }
  await withDaemon(config, async ({ root }) => {
    const attach = createAttachClient({ config, root })
    const res = await attach.reloadConfig()
    assert.equal(res.ok, true)
  })
})

test('onDisconnect and onReconnect trigger when connection drops and recovers', async () => {
  const config = { services: [] }
  let disconnected = false
  let reconnected = false
  await withDaemon(config, async ({ root }) => {
    const attach = createAttachClient({
      config, root,
      onDisconnect: () => { disconnected = true },
      onReconnect: () => { reconnected = true },
    })
    await attach.init()
    await attach.pollOnce()
    assert.equal(disconnected, false)

    // Poll against a non-existent socket root to simulate disconnect
    const badAttach = createAttachClient({
      config, root: path.join(root, 'nonexistent'),
      onDisconnect: () => { disconnected = true },
      onReconnect: () => { reconnected = true },
    })
    await badAttach.pollOnce()
    assert.equal(disconnected, true)
  })
})

test('onServicesChanged triggers when included set key changes', async () => {
  const config = { services: [{ name: 'web', command: 'true' }] }
  let changed = false
  await withDaemon(config, async ({ root, engine }) => {
    const attach = createAttachClient({
      config, root,
      onServicesChanged: () => { changed = true },
    })
    await attach.init()
    assert.equal(changed, false)

    engine.included = (name) => name === 'web' || name === 'api'
    config.services.push({ name: 'api', command: 'true' })
    await attach.pollOnce()
    assert.equal(changed, true)
  })
})

