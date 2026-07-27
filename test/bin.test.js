'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const BIN = path.join(__dirname, '..', 'bin', 'vibestackr')

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-bin-test-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

// Runs vibestackr and waits for it to exit on its own (config errors, --help,
// arg validation — none of these start the interactive TUI).
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

// Runs vibestackr as the long-lived TUI, waits until `until()` is true (or a
// timeout), then sends SIGTERM and waits for *this process* to exit. Note
// this is the client/TUI process, not the actual daemon it attached to (or
// started) — SIGTERM here only detaches (same as pressing 'b'), it does NOT
// stop the daemon or the services it manages. Tests that need everything
// actually stopped call stopDaemon() as well.
async function runInteractive(args, cwd, until, { timeout = 3000 } = {}) {
  const child = spawn('node', [BIN, ...args], { cwd, stdio: ['ignore', 'ignore', 'ignore'] })
  // Registered immediately, not inside `finally` — if the child already
  // exited (e.g. it crashed on startup) before we get there, a listener
  // attached late would miss the event entirely and hang forever awaiting
  // an 'exit' that already happened.
  const exited = new Promise((resolve) => child.on('exit', resolve))
  const start = Date.now()
  try {
    while (!(await until())) {
      if (Date.now() - start > timeout) throw new Error('runInteractive: condition never became true')
      await new Promise((r) => setTimeout(r, 20))
    }
  } finally {
    child.kill('SIGTERM')
    await exited
  }
}

// Actually stops the daemon (and every service it manages) for `cwd`'s
// project — the counterpart to `npx vibestackr stop`.
function stopDaemon(cwd) {
  return runToCompletion(['stop'], cwd)
}

test('--help prints usage and exits 0', async () => {
  await withTmpDir(async (dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify({ services: [{ name: 'web', command: 'true' }] }))
    const { code, stdout } = await runToCompletion(['--help'], dir)
    assert.equal(code, 0)
    assert.match(stdout, /vibestackr/)
    assert.match(stdout, /--persist-logs/)
  })
})

test('exits 1 with a clear error when no config exists', async () => {
  await withTmpDir(async (dir) => {
    const { code, stderr } = await runToCompletion(['--help'], dir)
    assert.equal(code, 1)
    assert.match(stderr, /no config found/)
  })
})

test('exits 1 with a clear error when more than one config exists', async () => {
  await withTmpDir(async (dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), '{"services":[]}')
    fs.writeFileSync(path.join(dir, '.vibestackr.yaml'), 'services: []\n')
    const { code, stderr } = await runToCompletion(['--help'], dir)
    assert.equal(code, 1)
    assert.match(stderr, /multiple configs found/)
  })
})

test('--config points at an arbitrarily-named file, skipping auto-discovery', async () => {
  await withTmpDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'custom.config.json'), JSON.stringify({ services: [{ name: 'web', command: 'true' }] }))
    const { code, stdout } = await runToCompletion(['--config', 'custom.config.json', '--help'], dir)
    assert.equal(code, 0)
    assert.match(stdout, /web/) // --exclude's help text lists service names, proving the custom file was actually loaded
  })
})

test('--config with a missing file exits 1 with a clear error', async () => {
  await withTmpDir(async (dir) => {
    const { code, stderr } = await runToCompletion(['--config', 'missing.json', '--help'], dir)
    assert.equal(code, 1)
    assert.match(stderr, /config file not found/)
  })
})

test('--exclude and --only together exit 1', async () => {
  await withTmpDir(async (dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify({ services: [{ name: 'web', command: 'true' }] }))
    const { code, stderr } = await runToCompletion(['--exclude', 'web', '--only', 'web'], dir)
    assert.equal(code, 1)
    assert.match(stderr, /mutually exclusive/)
  })
})

test('--only starts just that service (and not one that only the excluded service needed)', async () => {
  await withTmpDir(async (dir) => {
    const config = {
      services: [
        { name: 'web', type: 'shell', cwd: '.', command: 'sh', args: ['-c', 'echo $$ > web.pid; sleep 30'] },
        { name: 'worker', type: 'shell', cwd: '.', command: 'sh', args: ['-c', 'echo $$ > worker.pid; sleep 30'], dependsOn: ['web'] },
        { name: 'unrelated', type: 'shell', cwd: '.', command: 'sh', args: ['-c', 'echo $$ > unrelated.pid; sleep 30'] },
      ],
    }
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify(config))
    const webPid = path.join(dir, 'web.pid')
    const unrelatedPid = path.join(dir, 'unrelated.pid')
    await runInteractive(['--only', 'web'], dir, () => fs.existsSync(webPid))
    assert.ok(fs.existsSync(webPid), 'web should have started')
    assert.equal(fs.existsSync(unrelatedPid), false, 'unrelated should not have started')
    assert.equal(fs.existsSync(path.join(dir, 'worker.pid')), false, 'worker should not have started (only web was requested)')
    // SIGTERM to the client only detaches — the daemon (and web) should
    // still be running until we explicitly stop it.
    const pid = Number(fs.readFileSync(webPid, 'utf8').trim())
    assert.equal(process.kill(pid, 0), true, 'web should still be running after the client detached')
    await stopDaemon(dir)
    assert.throws(() => process.kill(pid, 0), 'web should be gone once the daemon is actually stopped')
  })
})

test('logs/<name>.log is not created by default, but is with --persist-logs', async () => {
  await withTmpDir(async (dir) => {
    const config = { services: [{ name: 'web', type: 'shell', cwd: '.', command: 'sh', args: ['-c', 'echo hi; echo $$ > web.pid; sleep 30'] }] }
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify(config))

    await runInteractive([], dir, () => fs.existsSync(path.join(dir, 'web.pid')))
    assert.equal(fs.existsSync(path.join(dir, 'logs')), false)
    // --persist-logs only takes effect when starting a *new* daemon — stop
    // this one first, or the next invocation would just attach to it as-is.
    await stopDaemon(dir)

    fs.unlinkSync(path.join(dir, 'web.pid'))
    const logFile = path.join(dir, 'logs', 'web.log')
    // Check content, not just existence — the file is created (by
    // createWriteStream) slightly before the "hi" line is actually flushed
    // to it, so existsSync alone can race and read an empty file.
    await runInteractive(['--persist-logs'], dir, () => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('hi'))
    assert.ok(fs.readFileSync(logFile, 'utf8').includes('hi'))
    await stopDaemon(dir)
  })
})

test('--background starts the daemon and returns immediately, without opening a TUI', async () => {
  await withTmpDir(async (dir) => {
    const config = { services: [{ name: 'web', type: 'shell', cwd: '.', command: 'sh', args: ['-c', 'echo $$ > web.pid; sleep 30'] }] }
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify(config))

    const { code, stdout } = await runToCompletion(['--background'], dir)
    assert.equal(code, 0)
    assert.match(stdout, /background/)

    const webPid = path.join(dir, 'web.pid')
    const start = Date.now()
    while (!fs.existsSync(webPid)) {
      if (Date.now() - start > 3000) throw new Error('web never started under --background')
      await new Promise((r) => setTimeout(r, 20))
    }
    const pid = Number(fs.readFileSync(webPid, 'utf8').trim())
    assert.equal(process.kill(pid, 0), true)

    await stopDaemon(dir)
    assert.throws(() => process.kill(pid, 0))
  })
})

test('running vibestackr again in the same project attaches to the existing daemon instead of starting a new one', async () => {
  await withTmpDir(async (dir) => {
    const config = { services: [{ name: 'web', type: 'shell', cwd: '.', command: 'sh', args: ['-c', 'echo $$ > web.pid; sleep 30'] }] }
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify(config))
    const webPid = path.join(dir, 'web.pid')

    await runInteractive([], dir, () => fs.existsSync(webPid))
    const firstPid = fs.readFileSync(webPid, 'utf8').trim()

    // A second invocation, still with web's process from the first one
    // alive — if this started a fresh daemon instead of attaching, web would
    // get killed and respawned with a new pid.
    await runInteractive([], dir, () => fs.existsSync(webPid))
    assert.equal(fs.readFileSync(webPid, 'utf8').trim(), firstPid, 'web should never have been restarted')

    await stopDaemon(dir)
  })
})

test('vibestackr stop terminates the daemon and every service it manages', async () => {
  await withTmpDir(async (dir) => {
    const config = { services: [{ name: 'web', type: 'shell', cwd: '.', command: 'sh', args: ['-c', 'echo $$ > web.pid; sleep 30'] }] }
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify(config))
    const webPid = path.join(dir, 'web.pid')

    await runInteractive(['--background'], dir, () => fs.existsSync(webPid))
    const pid = Number(fs.readFileSync(webPid, 'utf8').trim())

    const { code, stdout } = await stopDaemon(dir)
    assert.equal(code, 0)
    assert.match(stdout, /stopped/)
    assert.throws(() => process.kill(pid, 0))
  })
})

test('vibestackr stop with nothing running exits 1 with a clear error', async () => {
  await withTmpDir(async (dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify({ services: [] }))
    const { code, stderr } = await stopDaemon(dir)
    assert.equal(code, 1)
    assert.match(stderr, /isn't running/)
  })
})
