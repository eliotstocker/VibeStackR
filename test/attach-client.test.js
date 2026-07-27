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

const waitUntil = async (predicate, { timeout = 3000, interval = 20 } = {}) => {
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
