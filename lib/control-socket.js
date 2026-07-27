'use strict'

// The engine-facing side of the daemon/attach architecture (see bin/vibestakr
// and lib/attach-client.js for the client side). The actual engine — the one
// spawning services and holding their stdout/stderr pipes — always lives in
// a detached daemon process with no TUI of its own; every TUI (freshly
// started, reattached, or `vibestakr mcp`) is a separate process that talks
// to that daemon exclusively through this Unix domain socket. None of them
// duplicate engine logic themselves.
//
// Protocol: newline-delimited JSON. Request `{id, method, params}` gets
// exactly one response `{id, result}` or `{id, error}`, then the connection
// is closed by the client — no need for anything heavier at this scale.

const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const NOT_RUNNING_MESSAGE = "vibestakr isn't running for this project — start it with `npx vibestakr` first"

// Lives under the user's home directory, keyed by a hash of the project
// root, rather than inside the project directory itself — Unix domain
// socket paths are capped at ~104 bytes on macOS/BSD, and a path nested
// inside the project (e.g. `<root>/.vibestakr/control.sock`) can blow past
// that on an unremarkable deeply-nested checkout. Keeping this fixed-length
// and root-independent avoids the limit entirely.
//
// Deliberately os.homedir() (HOME), not os.tmpdir() (TMPDIR): `vibestakr mcp`
// is normally launched by an MCP client (Claude Code, Cursor, etc.), not
// directly by the user, and the standard MCP stdio transport only inherits a
// small safe-list of env vars for the spawned process — HOME is on that
// list, TMPDIR is not. Using tmpdir() here would make the TUI and
// `vibestakr mcp` compute two *different* base directories (e.g. macOS's
// real per-user /var/folders/.../T vs a bare fallback of /tmp) and never
// find each other's socket at all.
//
// realpathSync (not just path.resolve) matters too: two invocations of
// `process.cwd()` for "the same project" can differ if the path involves a
// symlink component, and a spawned child's reported cwd can come back fully
// resolved even when the path handed to it wasn't.
function projectHash(root) {
  let resolved
  try { resolved = fs.realpathSync(root) } catch { resolved = path.resolve(root) }
  return crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 16)
}

function socketPath(root) {
  return path.join(os.homedir(), '.vibestakr', 'sockets', `${projectHash(root)}.sock`)
}

// Where the daemon's own stdout/stderr (startup errors, crashes — not the
// services it manages, which always go through the ring buffer/--persist-logs
// regardless) land once it's detached and has no terminal of its own. Same
// homedir-based, hash-keyed placement as socketPath, for the same reasons.
function daemonLogPath(root) {
  return path.join(os.homedir(), '.vibestakr', 'daemon-logs', `${projectHash(root)}.log`)
}

function isSocketAlive(sockPath) {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

// The client side of the protocol above — connects, sends one request, reads
// exactly one response line, and closes. Shared by `vibestakr mcp`
// (lib/mcp-server.js), the attach client (lib/attach-client.js), and
// bin/vibestakr's own `stop` subcommand, rather than each reimplementing it.
function requestSocket(root, method, params) {
  return new Promise((resolve, reject) => {
    const sockPath = socketPath(root)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const sock = net.connect(sockPath)
    let buffer = ''

    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    sock.on('data', (chunk) => {
      buffer += chunk
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      const line = buffer.slice(0, idx)
      sock.end()
      try {
        const res = JSON.parse(line)
        if (res.error) reject(new Error(res.error))
        else resolve(res.result)
      } catch (err) {
        reject(err)
      }
    })
    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new Error(NOT_RUNNING_MESSAGE))
      else reject(err)
    })
  })
}

async function dispatch(method, params, { engine, config, onQuit, onReloadConfig }) {
  switch (method) {
    case 'status':
      return engine.getStatusSnapshot()
    case 'logs': {
      if (!params || !params.name) throw new Error("'logs' requires a service name")
      return { lines: engine.getLogs(params.name, params.lines) }
    }
    // Cursor-based tailing for a polling attach client (see
    // lib/attach-client.js) — distinct from 'logs' above (a fixed
    // last-N-lines snapshot, what `vibestakr mcp`'s get_logs tool uses) so
    // that contract doesn't have to shift shape to also serve tailing.
    case 'tail': {
      if (!params || !params.name) throw new Error("'tail' requires a service name")
      return engine.getLogsSince(params.name, params.since)
    }
    case 'restart': {
      if (!params || !params.name) throw new Error("'restart' requires a service name")
      // engine.restartService() itself silently no-ops for an unknown name
      // (fine for a keyboard shortcut misconfigured in the project's own
      // config), but a typo'd name coming from an agent over MCP deserves a
      // real error rather than a silent {status: null}.
      if (!config.services.some((s) => s.name === params.name)) throw new Error(`no service named '${params.name}'`)
      await engine.restartService(params.name)
      return { status: engine.getStatusSnapshot()[params.name] ?? null }
    }
    // Static, config-derived info per service (as opposed to 'status', which
    // is purely runtime state) — what `vibestakr mcp`'s get_services tool
    // uses to answer "what's actually configured for this service", e.g.
    // whether it has a `watcher` (auto-restarts/reloads itself on file
    // changes, like nodemon or vite HMR — informational only, vibestakr
    // doesn't implement the watching itself).
    case 'services': {
      const snapshot = engine.getStatusSnapshot()
      return {
        services: config.services.map((s) => ({
          name: s.name,
          type: s.type ?? null,
          note: s.note ?? null,
          watcher: !!s.watcher,
          oneShot: !!s.oneShot,
          dependsOn: s.dependsOn || [],
          liveness: s.liveness ? s.liveness.type : null,
          included: engine.included(s.name),
          status: snapshot[s.name] ?? null,
        })),
      }
    }
    case 'shortcuts':
      return { shortcuts: (config.shortcuts || []).map((s) => ({ key: s.key, label: s.label })) }
    case 'run_shortcut': {
      if (!params || !params.key) throw new Error("'run_shortcut' requires a key")
      const shortcut = (config.shortcuts || []).find((s) => s.key === params.key)
      if (!shortcut) throw new Error(`no shortcut with key '${params.key}'`)
      await engine.runShortcut(shortcut)
      return { ok: true }
    }
    // Fully stops the daemon (and every service it manages) — as opposed to
    // a client just detaching, which never touches this socket at all. The
    // actual shutdown is deferred a tick (via `onQuit`, not awaited here) so
    // this method's own `{ok: true}` response has a chance to flush to the
    // caller before the process that's serving it exits.
    case 'quit':
      setImmediate(() => onQuit())
      return { ok: true }
    // Re-reads the config file from disk and applies it to the already-
    // running daemon (see engine.reloadConfig()'s own comment for exactly
    // what that does/doesn't do) — `onReloadConfig` (bin/vibestakr) owns the
    // actual file read + schema validation, this socket layer just surfaces
    // whatever it throws (a bad edit) as a normal error response rather than
    // a rejected connection.
    case 'reload_config':
      await onReloadConfig()
      return { ok: true }
    default:
      throw new Error(`unknown method '${method}'`)
  }
}

function handleConnection(conn, ctx) {
  let buffer = ''
  conn.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      handleLine(conn, line, ctx)
    }
  })
  conn.on('error', () => {}) // a client disconnecting mid-request isn't this process's problem
}

async function handleLine(conn, line, ctx) {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    // No `id` to echo back, but the caller still needs *a* response line —
    // silently dropping this would leave a client waiting on a '\n' that
    // never arrives, hanging forever instead of erroring cleanly.
    conn.write(`${JSON.stringify({ id: null, error: 'malformed request: invalid JSON' })}\n`)
    return
  }
  const { id, method, params } = req
  try {
    const result = await dispatch(method, params, ctx)
    conn.write(JSON.stringify({ id, result }) + '\n')
  } catch (err) {
    conn.write(JSON.stringify({ id, error: err.message }) + '\n')
  }
}

// Starts listening, or returns `{ ok: false, reason }` if another vibestakr
// is already serving this project's socket, or if binding fails for any
// other reason (permissions, some other IPC oddity, etc). This is an
// optional layer, not a dependency the TUI needs to function — any failure
// here should be a warning the caller logs and moves on from, never fatal to
// the whole process. Cleans up a stale socket file left by an unclean
// previous shutdown. `onQuit` is called (not awaited) when a client sends the
// 'quit' method — normally the same shutdown function the daemon already
// uses for SIGINT/SIGTERM. `onReloadConfig` (awaited, its rejection becomes
// the 'reload_config' response's error) is the daemon's own re-read-file-
// from-disk-then-engine.reloadConfig() function.
async function startControlSocket({ engine, config, root, onQuit, onReloadConfig }) {
  const sockPath = socketPath(root)
  try {
    await fs.promises.mkdir(path.dirname(sockPath), { recursive: true })

    if (fs.existsSync(sockPath)) {
      if (await isSocketAlive(sockPath)) return { ok: false, reason: 'already running' }
      fs.unlinkSync(sockPath)
    }

    const server = net.createServer((conn) => handleConnection(conn, { engine, config, onQuit, onReloadConfig }))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(sockPath, resolve)
    })
    return { ok: true, server, sockPath }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

function stopControlSocket(handle) {
  if (!handle || !handle.ok) return
  handle.server.close()
  try { fs.unlinkSync(handle.sockPath) } catch { /* already gone */ }
}

module.exports = {
  startControlSocket,
  stopControlSocket,
  socketPath,
  daemonLogPath,
  isSocketAlive,
  requestSocket,
  NOT_RUNNING_MESSAGE,
}
