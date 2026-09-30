'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { createEngine, goInstallReason, rustInstallReason, pythonInstallReason, pythonInstallCommand, interpolateShortcutInputs, normalizeInputOptions } = require('../lib/engine')

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

const waitUntil = async (predicate, { timeout = 10000, interval = 20 } = {}) => {
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

test('killService runs stopCommand even for a long-running service that is still alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-stopcmd-test-'))
  const marker = path.join(dir, 'stopped')
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'], stopCommand: `touch ${marker}` }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.children.has('web'))
    await engine.killService('web')
    assert.ok(fs.existsSync(marker))
  })
})

test('killService runs stopCommand for a oneShot service whose process already exited (e.g. docker run -d)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-stopcmd-test-'))
  const marker = path.join(dir, 'stopped')
  const config = { services: [{ name: 'db', command: 'true', oneShot: true, stopCommand: `touch ${marker}` }] }
  await withEngine(config, {}, async (engine) => {
    const { ready } = engine.spawnService(config.services[0])
    await ready // process has already exited by the time this resolves
    await engine.killService('db')
    assert.ok(fs.existsSync(marker))
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

test('spawnService: a missing command (ENOENT) fails just that service, with a clear reason, instead of crashing the daemon', async () => {
  const config = { services: [{ name: 'web', command: './does-not-exist-xyz.sh', args: [] }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.status.get('web') === 'failed')
    assert.equal(engine.status.get('web'), 'failed')
    assert.ok(
      engine.getLogs('run-local').some((l) => l.includes('web') && l.includes('failed to start') && l.includes('ENOENT')),
      `expected a clear ENOENT failure message, got: ${JSON.stringify(engine.getLogs('run-local'))}`,
    )
  })
})

test('spawnService: a failing install step (e.g. missing install tool) fails just that service, not the daemon', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-install-fail-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  const config = { services: [{ name: 'api', type: 'node', cwd: dir, command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    // Force npm install itself to fail with a clear, distinct error rather
    // than relying on npm being absent from the test machine's PATH.
    const origPath = process.env.PATH
    process.env.PATH = ''
    try {
      engine.spawnService(config.services[0])
      await waitUntil(() => engine.status.get('api') === 'failed')
    } finally {
      process.env.PATH = origPath
    }
    assert.equal(engine.status.get('api'), 'failed')
    assert.ok(!engine.children.has('api')) // never got as far as spawning the actual service command
    assert.ok(
      engine.getLogs('run-local').some((l) => l.includes('api') && l.includes('install step failed')),
      `expected a clear install-step failure message, got: ${JSON.stringify(engine.getLogs('run-local'))}`,
    )
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJob: a missing job command (ENOENT) reports "failed:" with a clear reason, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-job-enoent-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { greet: 'echo hi' } }))
  const config = { services: [{ name: 'web', cwd: dir, command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    // npm:greet resolves to `npm run greet` — make `npm` itself unresolvable.
    const origPath = process.env.PATH
    process.env.PATH = ''
    let tab
    try {
      tab = engine.runJob('web', 'npm:greet')
      await waitUntil(() => (engine.getJobStatus(tab) || '').startsWith('failed:'))
    } finally {
      process.env.PATH = origPath
    }
    assert.match(engine.getJobStatus(tab), /^failed:/)
    assert.ok(
      engine.getLogs(tab).some((l) => l.includes('failed to start') && l.includes('ENOENT')),
      `expected a clear ENOENT failure message, got: ${JSON.stringify(engine.getLogs(tab))}`,
    )
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJob: succeeding job streams output into its own tab and reports "succeeded"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-job-test-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { greet: 'echo hello-from-job' } }))
  const config = { services: [{ name: 'web', cwd: dir, command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    const tab = engine.runJob('web', 'npm:greet')
    assert.match(tab, /^job:web:npm:greet:\d+$/)
    await waitUntil(() => engine.getJobStatus(tab) === 'succeeded')
    assert.ok(engine.getLogs(tab).some((l) => l.includes('hello-from-job')))
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJob: failing job reports "failed:<code>"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-job-test-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { boom: 'exit 3' } }))
  const config = { services: [{ name: 'web', cwd: dir, command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    const tab = engine.runJob('web', 'npm:boom')
    await waitUntil(() => engine.getJobStatus(tab) === 'failed:3')
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJob: unknown service or job throws', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    assert.throws(() => engine.runJob('nope', 'npm:build'), /no service/)
    assert.throws(() => engine.runJob('web', 'npm:build'), /no job/)
  })
})

test('discoverJobsForService/discoverAllJobs surface npm scripts per service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-job-test-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'echo build' } }))
  const config = { services: [{ name: 'web', cwd: dir, command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    assert.deepEqual(engine.discoverJobsForService('web'), [{ id: 'npm:build', source: 'npm', label: 'build', command: 'npm', args: ['run', 'build'] }])
    assert.deepEqual(engine.discoverAllJobs(), [{ name: 'web', jobs: engine.discoverJobsForService('web') }])
    assert.throws(() => engine.discoverJobsForService('nope'), /no service/)
  })
  fs.rmSync(dir, { recursive: true, force: true })
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

test('runShortcut: restart-type shortcut with an array restarts every named service', async () => {
  const config = {
    services: [
      { name: 'web', command: 'sh', args: ['-c', 'sleep 30'] },
      { name: 'worker', command: 'sh', args: ['-c', 'sleep 30'] },
    ],
  }
  await withEngine(config, {}, async (engine) => {
    await engine.runShortcut({ key: 'r', label: 'restart both', restart: ['web', 'worker'] })
    await waitUntil(() => engine.children.has('web') && engine.children.has('worker'))
    assert.ok(engine.children.has('web'))
    assert.ok(engine.children.has('worker'))
  })
})

test('runShortcut: jobs[]-type shortcut runs every job, one tab each', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-multi-job-test-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { a: 'echo job-a', b: 'echo job-b' } }))
  const config = { services: [{ name: 'web', cwd: dir, command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    const result = await engine.runShortcut({
      key: 'j', label: 'run a and b',
      jobs: [{ service: 'web', job: 'npm:a' }, { service: 'web', job: 'npm:b' }],
    })
    assert.equal(result.tabs.length, 2)
    await waitUntil(() => result.tabs.every((t) => engine.getJobStatus(t) === 'succeeded'))
    assert.ok(engine.getLogs(result.tabs[0]).some((l) => l.includes('job-a')))
    assert.ok(engine.getLogs(result.tabs[1]).some((l) => l.includes('job-b')))
  })
  fs.rmSync(dir, { recursive: true, force: true })
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

// Regression: parsed envFiles were cached forever, so a restart after
// editing the file still got the old values.
test('envFile edits are picked up by the next spawn (restart), not served from a stale cache', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', 'echo FOO=$FOO; sleep 30'], envFile: '.env' }] }
  await withEngine(config, {}, async (engine, dir) => {
    fs.writeFileSync(path.join(dir, '.env'), 'FOO=one\n')
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogs('web').includes('FOO=one'))
    fs.writeFileSync(path.join(dir, '.env'), 'FOO=second\n')
    await engine.restartService('web')
    await waitUntil(() => engine.getLogs('web').includes('FOO=second'))
  })
})

// ── reloadConfig ──────────────────────────────────────────────────────────

const printsFoo = (extra = {}) => ({ name: 'web', command: 'sh', args: ['-c', 'echo FOO=$FOO; sleep 30'], ...extra })

test('reloadConfig restarts a running service whose env{} changed, and leaves an unchanged one alone', async () => {
  const config = { services: [printsFoo({ env: { FOO: 'old' } }), { name: 'other', command: 'sh', args: ['-c', 'sleep 30'] }] }
  await withEngine(config, {}, async (engine) => {
    for (const s of config.services) engine.spawnService(s)
    await waitUntil(() => engine.getLogs('web').includes('FOO=old'))
    const otherPid = engine.children.get('other').proc.pid

    const summary = await engine.reloadConfig({ services: [printsFoo({ env: { FOO: 'new' } }), { name: 'other', command: 'sh', args: ['-c', 'sleep 30'] }] })
    assert.deepEqual(summary, { started: [], restarted: ['web'], changedOneShot: [] })
    await waitUntil(() => engine.getLogs('web').includes('FOO=new'))
    assert.equal(engine.children.get('other').proc.pid, otherPid)
  })
})

test('reloadConfig restarts a service whose envFile *contents* changed, even with an identical config', async () => {
  const config = { services: [printsFoo({ envFile: '.env' })] }
  await withEngine(config, {}, async (engine, dir) => {
    fs.writeFileSync(path.join(dir, '.env'), 'FOO=before\n')
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogs('web').includes('FOO=before'))
    fs.writeFileSync(path.join(dir, '.env'), 'FOO=after-edit\n')
    const summary = await engine.reloadConfig({ services: [printsFoo({ envFile: '.env' })] })
    assert.deepEqual(summary.restarted, ['web'])
    await waitUntil(() => engine.getLogs('web').includes('FOO=after-edit'))
  })
})

test('reloadConfig reports, but does not re-run, a changed oneShot service; starts a new one', async () => {
  const config = { services: [{ name: 'migrate', command: 'sh', args: ['-c', 'echo ran'], oneShot: true }] }
  await withEngine(config, {}, async (engine) => {
    await engine.spawnService(config.services[0]).ready
    const summary = await engine.reloadConfig({ services: [
      { name: 'migrate', command: 'sh', args: ['-c', 'echo ran-v2'], oneShot: true },
      { name: 'fresh', command: 'sh', args: ['-c', 'sleep 30'] },
    ] })
    assert.deepEqual(summary, { started: ['fresh'], restarted: [], changedOneShot: ['migrate'] })
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(!engine.getLogs('migrate').includes('ran-v2'))
  })
})

const liveProcessesMatching = (marker) =>
  spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length

// Regression (PR review): overlapping reloads each saw the old fingerprint
// and each spawned a replacement — an untracked orphan left running.
test('overlapping reloads leave exactly one live process, running the last config', async () => {
  const marker = `vibestackr-reload-race-${process.pid}-${Date.now()}`
  const svc = (foo) => ({ name: 'web', command: 'sh', args: ['-c', `echo FOO=$FOO; sleep 30 # ${marker}`], env: { FOO: foo } })
  await withEngine({ services: [svc('a')] }, {}, async (engine) => {
    engine.spawnService(svc('a'))
    await waitUntil(() => engine.getLogs('web').includes('FOO=a'))
    await Promise.all([engine.reloadConfig({ services: [svc('b')] }), engine.reloadConfig({ services: [svc('c')] })])
    await waitUntil(() => engine.getLogs('web').includes('FOO=c'))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(liveProcessesMatching(marker), 1)
  })
})

test('reloading autoRestart: false -> true applies to the already-running process', async () => {
  const svc = (autoRestart) => ({ name: 'web', command: 'sh', args: ['-c', 'while [ ! -f go ]; do sleep 0.05; done; exit 1'], autoRestart })
  await withEngine({ services: [svc(false)] }, {}, async (engine, dir) => {
    engine.spawnService(svc(false))
    await waitUntil(() => engine.status.get('web') === 'starting')
    const summary = await engine.reloadConfig({ services: [svc(true)] })
    assert.deepEqual(summary.restarted, []) // not a spawn-shaping change — no restart needed
    fs.writeFileSync(path.join(dir, 'go'), '')
    await waitUntil(() => engine.getLogs('run-local').some((l) => l.includes('autoRestart') && l.includes('attempt 1')))
  })
})

test('a manual restart during autoRestart backoff cancels the pending respawn instead of adding a second copy', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', '[ -f ok ] && { echo spawned; sleep 30; } || exit 1'], autoRestart: true }] }
  await withEngine(config, {}, async (engine, dir) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogs('run-local').some((l) => l.includes('attempt 1'))) // 1s backoff timer now pending
    fs.writeFileSync(path.join(dir, 'ok'), '')
    await engine.restartService('web')
    await new Promise((r) => setTimeout(r, 1500)) // past when the backoff timer would have fired
    assert.equal(engine.getLogs('web').filter((l) => l === 'spawned').length, 1)
  })
})

// The backgrounded sleep holds stdout open past sh's own exit, so 'exit'
// fires before the unterminated last line commits on stdout's 'end' — the
// exact order that used to lose it from the file.
test('--persist-logs keeps a final line that has no trailing newline, even when it lands after exit', async () => {
  const config = { services: [{ name: 'web', command: 'sh', args: ['-c', "echo first; printf 'last-no-newline'; sleep 0.3 &"], oneShot: true }] }
  await withEngine(config, { persistLogs: true }, async (engine, dir) => {
    await engine.spawnService(config.services[0]).ready
    const file = path.join(dir, 'logs', 'web.log')
    await waitUntil(() => engine.getLogs('web').includes('last-no-newline'))
    await waitUntil(() => fs.readFileSync(file, 'utf8').includes('last-no-newline'))
  })
})

test('loadEnvFile on reload unsets a key deleted from the file, restoring a shell value it had shadowed', async () => {
  const config = { services: [] }
  process.env.VIBESTACKR_TEST_SHELL = 'from-shell'
  delete process.env.VIBESTACKR_TEST_ONLY_FILE
  try {
    await withEngine(config, {}, async (engine, dir) => {
      const file = path.join(dir, '.env')
      fs.writeFileSync(file, 'VIBESTACKR_TEST_ONLY_FILE=x\n')
      engine.loadEnvFile(file)
      assert.equal(process.env.VIBESTACKR_TEST_ONLY_FILE, 'x')
      fs.writeFileSync(file, 'VIBESTACKR_TEST_SHELL=from-file\n')
      engine.loadEnvFile(file, { overwrite: true })
      assert.equal(process.env.VIBESTACKR_TEST_ONLY_FILE, undefined) // removed from file -> unset
      assert.equal(process.env.VIBESTACKR_TEST_SHELL, 'from-file')
      fs.writeFileSync(file, '')
      engine.loadEnvFile(file, { overwrite: true })
      assert.equal(process.env.VIBESTACKR_TEST_SHELL, 'from-shell') // shell value back, not deleted
    })
  } finally {
    delete process.env.VIBESTACKR_TEST_SHELL
    delete process.env.VIBESTACKR_TEST_ONLY_FILE
  }
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

// Regression: readline ended a line on every bare `\r`, so each frame of a
// redrawn progress bar landed in the buffer as its own (near-duplicate) line.
test('\\r-redrawn output commits once as its final frame, with the in-progress frame exposed as partial', async () => {
  // Second frame gated on a file the test creates (not a timer), so a slow
  // machine can't race past the in-progress frame before it's observed.
  const go = path.join(os.tmpdir(), `vibestackr-go-${process.pid}-${Date.now()}`)
  const script = `process.stdout.write('\\rprogress 50%'); const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(go)})) { clearInterval(t); process.stdout.write('\\rprogress 100%\\nfinal, no newline') } }, 20)`
  const config = { services: [{ name: 'bar', command: process.execPath, args: ['-e', script], oneShot: true }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getLogsSince('bar').partial[0] === 'progress 50%')
    assert.deepEqual(engine.getLogs('bar'), []) // nothing committed yet
    fs.writeFileSync(go, '')
    await waitUntil(() => engine.getLogs('bar').length === 2)
    assert.deepEqual(engine.getLogs('bar'), ['progress 100%', 'final, no newline'])
    assert.deepEqual(engine.getLogsSince('bar').partial, [])
  })
  fs.rmSync(go, { force: true })
})

// A grandchild that ignores SIGTERM keeps the old stdout pipe open after the
// restart, so that stream's 'end' (the splitter's own cleanup) never comes —
// the partial must be retired on the process's exit instead, or the old and
// new process's identical in-progress lines both show.
test('restart does not leave the killed process\'s in-progress line alongside the new one\'s', async () => {
  const config = { services: [{ name: 'dl', command: 'sh', args: ['-c', "printf 'Downloading 42%%'; (trap '' TERM; sleep 3) & wait"] }] }
  await withEngine(config, {}, async (engine) => {
    engine.spawnService(config.services[0])
    await waitUntil(() => engine.getPartial('dl').length === 1)
    await engine.restartService('dl')
    await waitUntil(() => engine.getPartial('dl')[0] === 'Downloading 42%')
    await new Promise((r) => setTimeout(r, 200)) // give a stale one time to (wrongly) still be there
    assert.deepEqual(engine.getPartial('dl'), ['Downloading 42%'])
  })
})

test('runSync (command shortcuts, install steps) collapses \\r redraws too', async () => {
  const config = { services: [], shortcuts: [{ key: 'p', label: 'progress', command: "printf '\\r1/3\\r2/3\\r3/3\\n'" }] }
  await withEngine(config, {}, async (engine) => {
    engine.runShortcut(config.shortcuts[0])
    // exclude the `running shortcut ...` echo of the command text itself
    const lines = engine.getLogs('run-local').filter((l) => l.includes('/3') && !l.includes('running shortcut'))
    assert.equal(lines.length, 1)
    assert.match(lines[0], /3\/3$/)
  })
})

// ── go/rust/python install-step detection ─────────────────────────────────

function tmpProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-install-test-'))
}

test('goInstallReason: no go.mod means nothing to install', () => {
  const dir = tmpProjectDir()
  assert.equal(goInstallReason(dir), null)
})

test('goInstallReason: go.mod present with no marker yet is "first run"', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/go.mod`, 'module example\n')
  assert.equal(goInstallReason(dir), 'first run')
})

test('goInstallReason: marker newer than go.sum means already installed', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/go.sum`, '')
  fs.writeFileSync(`${dir}/.vibestackr-go-installed`, '')
  assert.equal(goInstallReason(dir), null)
})

test('goInstallReason: go.sum touched after the marker means reinstall', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/.vibestackr-go-installed`, '')
  fs.utimesSync(`${dir}/.vibestackr-go-installed`, new Date(Date.now() - 10000), new Date(Date.now() - 10000))
  fs.writeFileSync(`${dir}/go.sum`, '')
  assert.equal(goInstallReason(dir), 'manifest changed since last install')
})

test('rustInstallReason: Cargo.toml present with no marker yet is "first run"', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/Cargo.toml`, '[package]\n')
  assert.equal(rustInstallReason(dir), 'first run')
})

test('pythonInstallReason: requirements.txt present with no marker yet is "first run"', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/requirements.txt`, 'flask\n')
  assert.equal(pythonInstallReason(dir), 'first run')
})

test('pythonInstallCommand: prefers uv when uv.lock exists, even alongside other manifests', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/uv.lock`, '')
  fs.writeFileSync(`${dir}/requirements.txt`, '')
  assert.deepEqual(pythonInstallCommand(dir), { command: 'uv', args: ['sync'] })
})

test('pythonInstallCommand: prefers poetry when poetry.lock exists', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/poetry.lock`, '')
  fs.writeFileSync(`${dir}/requirements.txt`, '')
  assert.deepEqual(pythonInstallCommand(dir), { command: 'poetry', args: ['install'] })
})

test('pythonInstallCommand: falls back to pip -r requirements.txt with no lockfile', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/requirements.txt`, '')
  assert.deepEqual(pythonInstallCommand(dir), { command: 'pip', args: ['install', '-r', 'requirements.txt'] })
})

test('pythonInstallCommand: passes extra[] as repeated --extra flags for uv', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/uv.lock`, '')
  assert.deepEqual(pythonInstallCommand(dir, ['dev', 'test']), { command: 'uv', args: ['sync', '--extra', 'dev', '--extra', 'test'] })
})

test('pythonInstallCommand: passes extra[] as repeated --with flags for poetry', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/poetry.lock`, '')
  assert.deepEqual(pythonInstallCommand(dir, ['dev']), { command: 'poetry', args: ['install', '--with', 'dev'] })
})

test('pythonInstallCommand: ignores extra[] for pip (no equivalent concept)', () => {
  const dir = tmpProjectDir()
  fs.writeFileSync(`${dir}/requirements.txt`, '')
  assert.deepEqual(pythonInstallCommand(dir, ['dev']), { command: 'pip', args: ['install', '-r', 'requirements.txt'] })
})

// ── interactive shortcuts[].inputs ────────────────────────────────────────

test('interpolateShortcutInputs: substitutes ${name} with the given value', () => {
  const result = interpolateShortcutInputs('echo ${msg}', [{ name: 'msg' }], { msg: 'hello world' })
  assert.equal(result, "echo 'hello world'")
})

test('interpolateShortcutInputs: falls back to the input\'s own default when no value given', () => {
  const result = interpolateShortcutInputs('echo ${msg}', [{ name: 'msg', default: 'fallback' }], {})
  assert.equal(result, "echo 'fallback'")
})

test('interpolateShortcutInputs: shell-quotes a value so it cannot inject additional shell syntax', () => {
  const result = interpolateShortcutInputs('echo ${msg}', [{ name: 'msg' }], { msg: "hi'; rm -rf /tmp/whatever; echo '" })
  assert.equal(result, "echo 'hi'\\''; rm -rf /tmp/whatever; echo '\\'''")
})

test('interpolateShortcutInputs: an options[] input accepts a listed value (string or {value,label} form)', () => {
  const inputs = [{ name: 'env', options: ['dev', { value: 'stg', label: 'Staging' }] }]
  assert.equal(interpolateShortcutInputs('deploy ${env}', inputs, { env: 'stg' }), "deploy 'stg'")
})

test('interpolateShortcutInputs: an options[] input rejects an unlisted value rather than running it', () => {
  const inputs = [{ name: 'env', options: ['dev', 'stg'] }]
  assert.throws(() => interpolateShortcutInputs('deploy ${env}', inputs, { env: 'prod' }), /must be one of: dev, stg/)
})

test('interpolateShortcutInputs: an options[] input with no value falls back to default, then the first option', () => {
  assert.equal(interpolateShortcutInputs('x ${e}', [{ name: 'e', options: ['a', 'b'], default: 'b' }], {}), "x 'b'")
  assert.equal(interpolateShortcutInputs('x ${e}', [{ name: 'e', options: ['a', 'b'] }], { e: '' }), "x 'a'")
})

test('normalizeInputOptions: both entry shapes normalize to {value,label}; no options[] is null', () => {
  assert.deepEqual(normalizeInputOptions({ options: ['a', { value: 'b' }, { value: 'c', label: 'C' }] }), [
    { value: 'a', label: 'a' }, { value: 'b', label: 'b' }, { value: 'c', label: 'C' },
  ])
  assert.equal(normalizeInputOptions({ name: 'x' }), null)
})

test('interpolateShortcutInputs: with no inputs[] configured, the command passes through unchanged', () => {
  assert.equal(interpolateShortcutInputs('echo hi', undefined, {}), 'echo hi')
})

test('runShortcut: an interactive shortcut runs its command with ${name} substituted from values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-shortcut-test-'))
  const marker = path.join(dir, 'out.txt')
  const config = {
    services: [],
    shortcuts: [{ key: 'g', label: 'greet', command: `echo \${msg} > ${marker}`, inputs: [{ name: 'msg' }] }],
  }
  await withEngine(config, {}, async (engine) => {
    engine.runShortcut(config.shortcuts[0], { msg: 'hello from a shortcut' })
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'hello from a shortcut')
  })
})
