'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { createEngine } = require('../lib/engine')

const NOOP_UI = { write() {}, refreshStatus() {}, destroy() {} }
const baseArgs = () => ({ exclude: new Set(), only: new Set(), serviceLog: '', persistLogs: false })

// Every test that spawns real processes runs inside a throwaway cwd (service
// `cwd`/`logs/` are resolved relative to process.cwd(), same as bin/vibestackr
// does for a real project) and always tears down any children it started.
async function withEngine(config, args, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-engine-test-'))
  const prevCwd = process.cwd()
  process.chdir(dir)
  const engine = createEngine({ config, args: { ...baseArgs(), ...args } })
  engine.setUI(NOOP_UI)
  try {
    await fn(engine, dir)
  } finally {
    // quit() (not a manual killService loop) — it flips the `quitting` flag
    // that scheduleAutoRestart() checks before respawning, so a pending
    // autoRestart timer from an autoRestart test can't fire after teardown
    // and spawn a zombie process into this now-deleted tmp dir.
    await engine.quit()
    process.chdir(prevCwd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function listenOnFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const waitUntil = async (predicate, { timeout = 3000, interval = 20 } = {}) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

// ── included/isExcluded ──────────────────────────────────────────────────

test('included() defaults to everything when neither --exclude nor --only is set', () => {
  const config = { services: [{ name: 'a', command: 'true' }, { name: 'b', command: 'true' }] }
  const engine = createEngine({ config, args: baseArgs() })
  assert.equal(engine.included('a'), true)
  assert.equal(engine.included('b'), true)
})

test('--exclude removes just the named service(s)', () => {
  const config = { services: [{ name: 'a', command: 'true' }, { name: 'b', command: 'true' }] }
  const engine = createEngine({ config, args: { ...baseArgs(), exclude: new Set(['b']) } })
  assert.equal(engine.included('a'), true)
  assert.equal(engine.included('b'), false)
  assert.equal(engine.isExcluded('b'), true)
})

test('--only pulls in the transitive dependsOn closure', () => {
  const config = {
    services: [
      { name: 'postgres', command: 'true' },
      { name: 'plugin', command: 'true' },
      { name: 'service', command: 'true', dependsOn: ['postgres', 'plugin'] },
      { name: 'admin', command: 'true', dependsOn: ['service'] },
      { name: 'unrelated', command: 'true' },
    ],
  }
  const engine = createEngine({ config, args: { ...baseArgs(), only: new Set(['admin']) } })
  assert.equal(engine.included('admin'), true)
  assert.equal(engine.included('service'), true)
  assert.equal(engine.included('postgres'), true)
  assert.equal(engine.included('plugin'), true)
  assert.equal(engine.included('unrelated'), false)
})

test('--only with a name that has no dependsOn includes just that name', () => {
  const config = {
    services: [
      { name: 'web', command: 'true' },
      { name: 'worker', command: 'true', dependsOn: ['web'] },
    ],
  }
  const engine = createEngine({ config, args: { ...baseArgs(), only: new Set(['web']) } })
  assert.equal(engine.included('web'), true)
  assert.equal(engine.included('worker'), false)
})

// ── log()/warn() + ring buffer ───────────────────────────────────────────

test('log() and warn() land in the run-local ring buffer', () => {
  const config = { services: [] }
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  engine.log('hello')
  engine.warn('uh oh')
  const lines = engine.getLogs('run-local')
  assert.ok(lines.some((l) => l.includes('hello')))
  assert.ok(lines.some((l) => l.includes('WARNING') && l.includes('uh oh')))
})

// ── declarative conditions (via printWarnings, which never process.exits) ──

test('printWarnings: envSet/envUnset conditions gate the message', () => {
  const config = {
    services: [],
    warnings: [
      { message: 'should not fire', when: [{ envSet: 'VIBESTACKR_TEST_UNSET_VAR' }] },
      { message: 'should fire', when: [{ envUnset: 'VIBESTACKR_TEST_UNSET_VAR' }] },
    ],
  }
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  engine.printWarnings()
  const lines = engine.getLogs('run-local').join('\n')
  assert.ok(!lines.includes('should not fire'))
  assert.ok(lines.includes('should fire'))
})

test('printWarnings: commandExists/commandMissing conditions', () => {
  const config = {
    services: [],
    warnings: [
      { message: 'node exists', when: [{ commandExists: 'node' }] },
      { message: 'definitely-not-a-real-command missing', when: [{ commandMissing: 'definitely-not-a-real-command-xyz' }] },
    ],
  }
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  engine.printWarnings()
  const lines = engine.getLogs('run-local').join('\n')
  assert.ok(lines.includes('node exists'))
  assert.ok(lines.includes('definitely-not-a-real-command missing'))
})

test('printWarnings: commandFails and ${VAR} interpolation', () => {
  process.env.VIBESTACKR_TEST_VAR = 'interpolated'
  const config = {
    services: [],
    warnings: [
      { message: 'value is ${VIBESTACKR_TEST_VAR}', when: [{ commandFails: { command: 'sh', args: ['-c', 'exit 1'] } }] },
    ],
  }
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  engine.printWarnings()
  const lines = engine.getLogs('run-local').join('\n')
  delete process.env.VIBESTACKR_TEST_VAR
  assert.ok(lines.includes('value is interpolated'))
})

test('printWarnings: excluded/included/anyIncluded conditions respect --exclude', () => {
  const config = {
    services: [{ name: 'admin', command: 'true' }],
    warnings: [
      { service: 'admin', message: 'admin warning', when: [{ included: 'admin' }] },
      { message: 'fires because admin excluded', when: [{ excluded: 'admin' }] },
      { message: 'anyIncluded false', when: [{ anyIncluded: ['admin'] }] },
    ],
  }
  const engine = createEngine({ config, args: { ...baseArgs(), exclude: new Set(['admin']) } })
  engine.setUI(NOOP_UI)
  engine.printWarnings()
  const lines = engine.getLogs('run-local').join('\n')
  // service-scoped warning is skipped entirely once that service is excluded
  assert.ok(!lines.includes('admin warning'))
  assert.ok(lines.includes('fires because admin excluded'))
  assert.ok(!lines.includes('anyIncluded false'))
})

test('checkDeps: passes silently when nothing is missing', () => {
  const config = { services: [], dependencies: [{ message: 'never missing', when: [{ envUnset: 'PATH' }] }] }
  const engine = createEngine({ config, args: baseArgs() })
  engine.setUI(NOOP_UI)
  engine.checkDeps() // would process.exit(1) if it misbehaved
  assert.ok(engine.getLogs('run-local').join('\n').includes('all required dependencies present'))
})

// ── service lifecycle ────────────────────────────────────────────────────

test('spawnService: oneShot success runs onSuccess, sets status ready', async () => {
  const config = { services: [{ name: 'build', command: 'sh', args: ['-c', 'exit 0'], oneShot: true, onSuccess: 'echo done-marker' }] }
  await withEngine(config, {}, async (engine) => {
    const { ready } = engine.spawnService(config.services[0])
    await ready
    await waitUntil(() => engine.status.get('build') === 'ready')
    assert.equal(engine.status.get('build'), 'ready')
    await waitUntil(() => engine.getLogs('build').some((l) => l.includes('done-marker')))
  })
})

test('spawnService: oneShot failure does not run onSuccess, sets status failed', async () => {
  const config = { services: [{ name: 'build', command: 'sh', args: ['-c', 'exit 1'], oneShot: true, onSuccess: 'echo should-not-appear' }] }
  await withEngine(config, {}, async (engine) => {
    const { ready } = engine.spawnService(config.services[0])
    await ready
    await waitUntil(() => engine.status.get('build') === 'failed')
    assert.equal(engine.status.get('build'), 'failed')
    assert.ok(!engine.getLogs('build').some((l) => l.includes('should-not-appear')))
  })
})

test('spawnService: liveness type "command" flips status to ready', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'], liveness: { type: 'command', command: 'true', timeout: 5 } }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'ready')
    assert.equal(engine.status.get('web'), 'ready')
  })
})

test('spawnService: liveness type "port" flips status to ready once the port is open', async () => {
  const server = await listenOnFreePort()
  const port = server.address().port
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'], liveness: { type: 'port', host: '127.0.0.1', port, timeout: 5 } }] }
  try {
    await withEngine(config, {}, async (engine) => {
      engine.spawnService(config.services[0])
      await waitUntil(() => engine.status.get('web') === 'ready')
      assert.equal(engine.status.get('web'), 'ready')
    })
  } finally {
    server.close()
  }
})

test('spawnService: liveness timeout marks status "timeout" without hanging forever', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'], liveness: { type: 'command', command: 'false', timeout: 1 } }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'timeout', { timeout: 5000 })
    assert.equal(engine.status.get('web'), 'timeout')
  })
})

test('killService terminates the process group', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.children.has('web'))
    const pid = engine.children.get('web').proc.pid
    await engine.killService('web')
    assert.throws(() => process.kill(pid, 0)) // ESRCH — process is gone
  })
})

test('restartService replaces the running process', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.children.has('web'))
    const firstPid = engine.children.get('web').proc.pid
    await engine.restartService('web')
    const secondPid = engine.children.get('web').proc.pid
    assert.notEqual(firstPid, secondPid)
    assert.throws(() => process.kill(firstPid, 0))
  })
})

test('autoRestart: a crashing service is automatically respawned', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'exit 1'], autoRestart: true }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogs('run-local').some((l) => l.includes('autoRestart') && l.includes('attempt 1')))
    await waitUntil(() => engine.getLogs('run-local').some((l) => l.includes('attempt 2')), { timeout: 5000 })
  })
})

test('autoRestart: a crashing service without it set just stays "failed"', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'exit 1'] }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'failed')
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(!engine.getLogs('run-local').some((l) => l.includes('autoRestart')))
  })
})

test('runShortcut: restart-type shortcut starts the named service', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    await engine.runShortcut({ key: 'r', label: 'restart web', restart: 'web' })
    await waitUntil(() => engine.children.has('web'))
    assert.ok(engine.children.has('web'))
  })
})

test('runShortcut: command-type shortcut runs a shell command synchronously', async () => {
  const config = { services: [] }
  await withEngine(config, {}, async (engine) => {
    engine.runShortcut({ key: 'g', label: 'greet', command: 'echo shortcut-output' })
    assert.ok(engine.getLogs('run-local').some((l) => l.includes('shortcut-output')))
  })
})

// ── log persistence (--persist-logs) ─────────────────────────────────────

test('logs/<name>.log is NOT written by default', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'echo hi; sleep 30'] }] }
  await withEngine(config, { persistLogs: false }, async (engine, dir) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogs('web').includes('hi'))
    assert.equal(fs.existsSync(path.join(dir, 'logs')), false)
  })
})

test('--persist-logs writes logs/<name>.log', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'echo hi; sleep 30'] }] }
  await withEngine(config, { persistLogs: true }, async (engine, dir) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => fs.existsSync(path.join(dir, 'logs', 'web.log')) && fs.readFileSync(path.join(dir, 'logs', 'web.log'), 'utf8').includes('hi'))
    assert.ok(fs.readFileSync(path.join(dir, 'logs', 'web.log'), 'utf8').includes('hi'))
  })
})

test('envFile loads KEY=VALUE pairs into the service env, and env{} wins on conflict', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'echo FOO=$FOO BAR=$BAR'], envFile: '.env', env: { BAR: 'inline' } }] }
  await withEngine(config, {}, async (engine, dir) => {
    fs.writeFileSync(path.join(dir, '.env'), '# comment\n\nFOO=from-file\nBAR=should-be-overridden\n')
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogs('web').some((l) => l.includes('FOO=from-file')))
    assert.ok(engine.getLogs('web').some((l) => l.includes('FOO=from-file BAR=inline')))
  })
})

test('envFile pointing at a missing file is a no-op, not an error', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'echo done'], oneShot: true, envFile: '.env' }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogs('web').includes('done'))
    assert.ok(!engine.getLogs('run-local').some((l) => l.includes('envFile')))
  })
})

// ── startAll: dependsOn ordering ──────────────────────────────────────────

test('startAll: a dependent service does not start until its dependency is ready', async () => {
  const config = {
    services: [
      { name: 'db', command: 'sh', args: ['-c', 'sleep 30'], liveness: { type: 'command', command: 'true', timeout: 5 } },
      { name: 'app', command: 'sh', args: ['-c', 'sleep 30'], dependsOn: ['db'] },
    ],
  }
  await withEngine(config, {}, async (engine) => {
    assert.equal(engine.children.has('app'), false)
    const startAllPromise = engine.startAll()
    // app must not spawn before db is ready, even though db's liveness passes
    // almost immediately — give it a tick to prove it waited, not raced.
    await new Promise((r) => setImmediate(r))
    await waitUntil(() => engine.children.has('db'))
    await waitUntil(() => engine.children.has('app'))
    await startAllPromise
    assert.equal(engine.status.get('db'), 'ready')
  })
})

test('startAll: warns about a dependsOn referencing an unknown service', async () => {
  const config = { services: [{ name: 'app', command: 'true', dependsOn: ['ghost'] }] }
  await withEngine(config, {}, async (engine) => {
    await engine.startAll()
    assert.ok(engine.getLogs('run-local').some((l) => l.includes("unknown service 'ghost'")))
  })
})

// ── ring buffer cap ───────────────────────────────────────────────────────

test('per-service log ring buffer is capped rather than growing unbounded', async () => {
  const config = { services: [{ name: 'noisy', command: 'sh', args: ['-c', 'seq 1 25000'], oneShot: true }] }
  await withEngine(config, {}, async (engine) => {
    const { ready } = engine.spawnService(config.services[0])
    await ready
    const lines = engine.getLogs('noisy')
    assert.ok(lines.length <= 21000, `expected buffer to be capped, got ${lines.length}`)
    assert.equal(lines[lines.length - 1], '25000') // most recent line always survives trimming
  })
})
