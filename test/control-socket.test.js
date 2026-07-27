'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { createEngine } = require('../lib/engine')
const { startControlSocket, stopControlSocket, socketPath } = require('../lib/control-socket')

const NOOP_UI = { write() {}, refreshStatus() {}, destroy() {} }
const baseArgs = () => ({ exclude: new Set(), only: new Set(), serviceLog: '', persistLogs: false })

const waitUntil = async (predicate, { timeout = 3000, interval = 20 } = {}) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function request(sockPath, method, params) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath)
    let buffer = ''
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 'test', method, params })}\n`))
    sock.on('data', (chunk) => {
      buffer += chunk
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      sock.end()
      try { resolve(JSON.parse(buffer.slice(0, idx))) } catch (err) { reject(err) }
    })
    sock.on('error', reject)
  })
}

async function withEngine(config, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-socket-test-'))
  const prevCwd = process.cwd()
  process.chdir(root)
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  let handle = null
  try {
    handle = await startControlSocket({ engine, config, root })
    await fn(engine, handle, root)
  } finally {
    await Promise.all([...engine.children.keys()].map((n) => engine.killService(n)))
    stopControlSocket(handle)
    process.chdir(prevCwd)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('socketPath is short, stable for the same root, and differs across roots', () => {
  const deepRoot = `/some/deeply/nested/enterprise/monorepo/path/${'x'.repeat(80)}/actual-project`
  const p1 = socketPath(deepRoot)
  const p2 = socketPath(deepRoot)
  const p3 = socketPath('/a/totally/different/project')
  assert.equal(p1, p2)
  assert.notEqual(p1, p3)
  assert.ok(p1.length < 100, `expected a short path, got ${p1.length} chars: ${p1}`)
})

test('starts, serves status/logs/shortcuts over the socket, and stops cleanly', async () => {
  const config = {
    services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }],
    shortcuts: [{ key: 'g', label: 'greet', command: 'echo hi-from-shortcut' }],
  }
  await withEngine(config, async (engine, handle) => {
    assert.ok(handle.ok)

    const status1 = await request(handle.sockPath, 'status', {})
    assert.deepEqual(status1.result, {})

    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'starting')

    const status2 = await request(handle.sockPath, 'status', {})
    assert.equal(status2.result.web, 'starting')

    const shortcuts = await request(handle.sockPath, 'shortcuts', {})
    assert.deepEqual(shortcuts.result.shortcuts, [{ key: 'g', label: 'greet' }])

    const ran = await request(handle.sockPath, 'run_shortcut', { key: 'g' })
    assert.deepEqual(ran.result, { ok: true })
    await waitUntil(() => engine.getLogs('run-local').some((l) => l.includes('hi-from-shortcut')))

    const logs = await request(handle.sockPath, 'logs', { name: 'run-local' })
    assert.ok(Array.isArray(logs.result.lines))
    assert.ok(logs.result.lines.some((l) => l.includes('hi-from-shortcut')))
  })
})

test('services reports config-derived info per service, including watcher and current included/status', async () => {
  const config = {
    services: [
      { name: 'web', command: 'npm', args: ['run', 'dev'], watcher: true },
      { name: 'excluded-one', command: 'true' },
    ],
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-socket-test-'))
  const engine = createEngine({ config, args: { exclude: new Set(['excluded-one']), only: new Set(), serviceLog: '', persistLogs: false } })
  engine.setUI(NOOP_UI)
  let handle = null
  try {
    handle = await startControlSocket({ engine, config, root })
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'starting')

    const res = await request(handle.sockPath, 'services', {})
    const web = res.result.services.find((s) => s.name === 'web')
    const excluded = res.result.services.find((s) => s.name === 'excluded-one')
    assert.equal(web.watcher, true)
    assert.equal(web.included, true)
    assert.equal(web.status, 'starting')
    assert.equal(excluded.watcher, false)
    assert.equal(excluded.included, false)
    assert.equal(excluded.status, null)
  } finally {
    await Promise.all([...engine.children.keys()].map((n) => engine.killService(n)))
    stopControlSocket(handle)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('restart over the socket actually restarts the process', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }] }
  await withEngine(config, async (engine, handle) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.children.has('web'))
    const firstPid = engine.children.get('web').proc.pid

    const res = await request(handle.sockPath, 'restart', { name: 'web' })
    assert.equal(res.result.status, 'starting')
    await waitUntil(() => engine.children.get('web').proc.pid !== firstPid)
    assert.notEqual(engine.children.get('web').proc.pid, firstPid)
    assert.throws(() => process.kill(firstPid, 0))
  })
})

test('unknown method and unknown shortcut key return errors, not crashes', async () => {
  const config = { services: [], shortcuts: [] }
  await withEngine(config, async (engine, handle) => {
    const badMethod = await request(handle.sockPath, 'bogus', {})
    assert.match(badMethod.error, /unknown method/)

    const badShortcut = await request(handle.sockPath, 'run_shortcut', { key: 'zzz' })
    assert.match(badShortcut.error, /no shortcut/)

    const missingName = await request(handle.sockPath, 'logs', {})
    assert.match(missingName.error, /requires a service name/)
  })
})

test('restart with an unknown service name returns an error, not a silent no-op', async () => {
  const config = { services: [{ name: 'web', command: 'true' }], shortcuts: [] }
  await withEngine(config, async (engine, handle) => {
    const res = await request(handle.sockPath, 'restart', { name: 'typo-service' })
    assert.match(res.error, /no service named 'typo-service'/)
  })
})

test('restart with a shortcut of a restart-type (not command-type) actually restarts it', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 10'] }], shortcuts: [{ key: 'r', label: 'restart web', restart: 'web' }] }
  await withEngine(config, async (engine, handle) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.children.has('web'))
    const firstPid = engine.children.get('web').proc.pid

    const res = await request(handle.sockPath, 'run_shortcut', { key: 'r' })
    assert.deepEqual(res.result, { ok: true })
    await waitUntil(() => engine.children.get('web').proc.pid !== firstPid)
    assert.notEqual(engine.children.get('web').proc.pid, firstPid)
  })
})

test('logs with a `lines` param truncates to the most recent N lines', async () => {
  const config = { services: [{ name: 'noisy', command: 'sh', args: ['-c', 'seq 1 50'], oneShot: true }], shortcuts: [] }
  await withEngine(config, async (engine, handle) => {
    const { ready } = engine.spawnService(config.services[0])
    await ready
    const all = await request(handle.sockPath, 'logs', { name: 'noisy' })
    assert.equal(all.result.lines.length, 50)

    const last5 = await request(handle.sockPath, 'logs', { name: 'noisy', lines: 5 })
    assert.deepEqual(last5.result.lines, ['46', '47', '48', '49', '50'])
  })
})

test('tail returns only lines appended since the given cursor, plus the new total', async () => {
  const config = { services: [{ name: 'noisy', command: 'sh', args: ['-c', 'seq 1 5'], oneShot: true }], shortcuts: [] }
  await withEngine(config, async (engine, handle) => {
    const { ready } = engine.spawnService(config.services[0])
    await ready

    const first = await request(handle.sockPath, 'tail', { name: 'noisy', since: 0 })
    assert.deepEqual(first.result.lines, ['1', '2', '3', '4', '5'])
    assert.equal(first.result.total, 5)

    // nothing new since the cursor we were just given
    const second = await request(handle.sockPath, 'tail', { name: 'noisy', since: first.result.total })
    assert.deepEqual(second.result.lines, [])
    assert.equal(second.result.total, 5)
  })
})

test('tail with no since (or an out-of-range one) falls back to the whole current buffer', async () => {
  const config = { services: [{ name: 'noisy', command: 'sh', args: ['-c', 'seq 1 3'], oneShot: true }], shortcuts: [] }
  await withEngine(config, async (engine, handle) => {
    const { ready } = engine.spawnService(config.services[0])
    await ready
    const res = await request(handle.sockPath, 'tail', { name: 'noisy' })
    assert.deepEqual(res.result.lines, ['1', '2', '3'])
    assert.equal(res.result.total, 3)
  })
})

test('quit responds first, then actually shuts the socket down', async () => {
  const config = { services: [], shortcuts: [] }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-socket-test-'))
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  let quitCalled = false
  try {
    const handle = await startControlSocket({ engine, config, root, onQuit: () => { quitCalled = true; stopControlSocket(handle) } })
    const res = await request(handle.sockPath, 'quit', {})
    assert.deepEqual(res.result, { ok: true })
    await waitUntil(() => quitCalled)
    await waitUntil(() => !fs.existsSync(handle.sockPath))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('malformed JSON gets an error response instead of being silently dropped (which would hang the caller)', async () => {
  const config = { services: [], shortcuts: [] }
  await withEngine(config, async (engine, handle) => {
    const res = await new Promise((resolve, reject) => {
      const sock = net.connect(handle.sockPath)
      let buffer = ''
      sock.on('connect', () => sock.write('this is not json\n'))
      sock.on('data', (chunk) => {
        buffer += chunk
        const idx = buffer.indexOf('\n')
        if (idx === -1) return
        sock.end()
        try { resolve(JSON.parse(buffer.slice(0, idx))) } catch (err) { reject(err) }
      })
      sock.on('error', reject)
      setTimeout(() => reject(new Error('timed out waiting for a response — malformed request was silently dropped')), 2000)
    })
    assert.match(res.error, /malformed request/)
    assert.equal(res.id, null)

    // the connection/server must still be perfectly usable afterward
    const status = await request(handle.sockPath, 'status', {})
    assert.deepEqual(status.result, {})
  })
})

test('a second startControlSocket for the same still-alive root reports already running, not an error', async () => {
  const config = { services: [], shortcuts: [] }
  await withEngine(config, async (engine, handle, root) => {
    const second = await startControlSocket({ engine, config, root })
    assert.equal(second.ok, false)
    assert.match(second.reason, /already running/)
    // the first instance's socket must still be perfectly usable
    const status = await request(handle.sockPath, 'status', {})
    assert.deepEqual(status.result, {})
  })
})

test('stopControlSocket removes the socket file so a later start can rebind cleanly', async () => {
  const config = { services: [], shortcuts: [] }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-socket-test-'))
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  try {
    const handle1 = await startControlSocket({ engine, config, root })
    assert.ok(handle1.ok)
    stopControlSocket(handle1)
    assert.equal(fs.existsSync(handle1.sockPath), false)

    const handle2 = await startControlSocket({ engine, config, root })
    assert.ok(handle2.ok)
    stopControlSocket(handle2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a stale socket file (no listener behind it) is cleaned up and rebound', async () => {
  const config = { services: [], shortcuts: [] }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-socket-test-'))
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  try {
    const sockPath = socketPath(root)
    fs.mkdirSync(path.dirname(sockPath), { recursive: true })
    // A stale socket file: net.Server.close() actually unlinks the file
    // itself, so it can't be used to simulate this — real staleness only
    // happens when a previous process is killed (e.g. SIGKILL) without
    // getting a chance to close() at all, leaving the file orphaned with
    // nothing listening behind it. A plain leftover file reproduces exactly
    // that as far as startControlSocket is concerned: it doesn't care what
    // kind of file is there, only that connecting to it fails.
    fs.writeFileSync(sockPath, '')
    assert.ok(fs.existsSync(sockPath))

    const handle = await startControlSocket({ engine, config, root })
    assert.ok(handle.ok, `expected a clean rebind, got: ${JSON.stringify(handle)}`)
    stopControlSocket(handle)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
