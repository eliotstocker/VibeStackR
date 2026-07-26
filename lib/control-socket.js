'use strict'

// The engine-facing side of the MCP integration. Runs inside the TUI process
// and exposes the same engine the blessed UI already drives — status, logs
// (from the in-memory ring buffer), restart, shortcuts — over a project-local
// Unix domain socket. `vibestakr mcp` (lib/mcp-server.js) is a separate
// process/thin client that connects here and translates MCP tool calls into
// requests below; it does not duplicate any engine logic itself.
//
// Protocol: newline-delimited JSON. Request `{id, method, params}` gets
// exactly one response `{id, result}` or `{id, error}`, then the connection
// is closed by the client — no need for anything heavier at this scale.

const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

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
// realpathSync (not just path.resolve) matters too: the TUI and
// `vibestakr mcp` are two separate process invocations of `process.cwd()`,
// and if the project is reached through a symlinked path component, a
// spawned child's reported cwd can come back fully resolved even when the
// path handed to it wasn't — two calls that are "the same project" would
// otherwise hash to two different sockets.
function socketPath(root) {
  let resolved
  try { resolved = fs.realpathSync(root) } catch { resolved = path.resolve(root) }
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 16)
  return path.join(os.homedir(), '.vibestakr', 'sockets', `${hash}.sock`)
}

function isSocketAlive(sockPath) {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

async function dispatch(method, params, { engine, config }) {
  switch (method) {
    case 'status':
      return engine.getStatusSnapshot()
    case 'logs': {
      if (!params || !params.name) throw new Error("'logs' requires a service name")
      return { lines: engine.getLogs(params.name, params.lines) }
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
    case 'shortcuts':
      return { shortcuts: (config.shortcuts || []).map((s) => ({ key: s.key, label: s.label })) }
    case 'run_shortcut': {
      if (!params || !params.key) throw new Error("'run_shortcut' requires a key")
      const shortcut = (config.shortcuts || []).find((s) => s.key === params.key)
      if (!shortcut) throw new Error(`no shortcut with key '${params.key}'`)
      await engine.runShortcut(shortcut)
      return { ok: true }
    }
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
// previous shutdown.
async function startControlSocket({ engine, config, root }) {
  const sockPath = socketPath(root)
  try {
    await fs.promises.mkdir(path.dirname(sockPath), { recursive: true })

    if (fs.existsSync(sockPath)) {
      if (await isSocketAlive(sockPath)) return { ok: false, reason: 'already running' }
      fs.unlinkSync(sockPath)
    }

    const server = net.createServer((conn) => handleConnection(conn, { engine, config }))
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

module.exports = { startControlSocket, stopControlSocket, socketPath }
