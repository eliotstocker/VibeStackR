'use strict'

// Shared daemon start/stop logic — used by bin/vibestackr (the `--background`
// flag, a fresh `npx vibestackr` with no daemon yet, and `vibestackr stop`)
// and by lib/mcp-server.js's start_daemon/stop_daemon tools, so both spawn
// and tear down the daemon the exact same way instead of drifting apart.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { socketPath, daemonLogPath, isSocketAlive, requestSocket } = require('./control-socket')

const DAEMON_STARTUP_TIMEOUT_MS = 5000
const STOP_TIMEOUT_MS = 10000
const POLL_MS = 100

const BIN_PATH = path.join(__dirname, '..', 'bin', 'vibestackr')

// Spawns bin/vibestackr as a detached daemon (stdio redirected to its own log
// file, since it has no terminal of its own) and waits for either the control
// socket to come alive (success) or the process to exit early — e.g. a
// checkDeps() failure — whichever happens first, so a broken config fails
// fast instead of silently leaving nothing running.
async function startDaemon(root, daemonArgv) {
  const logPath = daemonLogPath(root)
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true })
  const logFd = fs.openSync(logPath, 'a')
  const child = spawn(process.execPath, [BIN_PATH, ...daemonArgv, '--daemon'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  fs.closeSync(logFd) // the child has its own duplicated fd now; this process doesn't need to keep it open
  child.unref()

  let exited = false
  child.once('exit', () => { exited = true })
  const start = Date.now()
  while (Date.now() - start < DAEMON_STARTUP_TIMEOUT_MS) {
    if (await isSocketAlive(socketPath(root))) return { ok: true, pid: child.pid }
    if (exited) return { ok: false }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return { ok: false }
}

// Requests a graceful 'quit' over the control socket, then waits for the
// daemon to actually finish (killing every service can take a moment) rather
// than declaring success the instant the request was merely accepted.
async function stopDaemon(root) {
  await requestSocket(root, 'quit', {})
  const start = Date.now()
  while (await isSocketAlive(socketPath(root))) {
    if (Date.now() - start > STOP_TIMEOUT_MS) {
      throw new Error(`still shutting down after ${STOP_TIMEOUT_MS / 1000}s — check ${daemonLogPath(root)}`)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

module.exports = { startDaemon, stopDaemon, DAEMON_STARTUP_TIMEOUT_MS, STOP_TIMEOUT_MS, POLL_MS }
