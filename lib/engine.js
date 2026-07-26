'use strict'

// The orchestration engine: process lifecycle, liveness, declarative
// dependency/warning checks, and log capture. No blessed/UI code here — the
// TUI (lib/ui.js) is one consumer of this engine's state; a future MCP
// server is another. Neither goes through the other.

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const net = require('net')
const readline = require('readline')

// Ring buffer cap per service — MCP/status consumers read from this instead
// of a log file, so it needs to hold enough scrollback to be useful without
// growing unbounded over a long dev session.
const LOG_CAP = 20000
const LOG_TRIM_MARGIN = 1000

function resolveIncludedSet(config, args) {
  const byName = new Map(config.services.map((s) => [s.name, s]))
  if (args.only && args.only.size) {
    // --only pulls in each named service's transitive dependsOn closure too
    // — starting just "admin" without also starting what it depends on
    // would otherwise hang forever waiting on a service that never starts.
    const include = new Set()
    const visit = (name) => {
      if (include.has(name) || !byName.has(name)) return
      include.add(name)
      for (const dep of byName.get(name).dependsOn || []) visit(dep)
    }
    for (const name of args.only) visit(name)
    return include
  }
  return new Set(config.services.map((s) => s.name).filter((n) => !args.exclude.has(n)))
}

// green/red/yellow traffic-light convention used throughout (tabs, borders,
// status bar) so a service's state reads the same everywhere at a glance.
const STATE_COLOR = (s) => (s === 'ready' ? 'green' : s === 'failed' || s === 'timeout' ? 'red' : 'yellow')
const STATE_GLYPH = (s) => (s === 'ready' ? '✓' : s === 'failed' || s === 'timeout' ? '✗' : '●')

function createEngine({ config, args }) {
  const ALL_NAMES = config.services.map((s) => s.name)
  const includedSet = resolveIncludedSet(config, args)
  const included = (name) => includedSet.has(name)
  const isExcluded = (name) => !included(name)

  const COLORS = [36, 35, 33, 32, 34, 31]
  const colorFor = (name) => COLORS[ALL_NAMES.indexOf(name) % COLORS.length] ?? 37
  const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`

  // ── log capture ──────────────────────────────────────────────────────────
  // Always kept in memory (this is what a status/logs consumer reads from);
  // writing to logs/<name>.log on top of that is opt-in via --persist-logs.
  const logBuffers = new Map() // name -> string[]
  function appendLog(name, line) {
    let buf = logBuffers.get(name)
    if (!buf) { buf = []; logBuffers.set(name, buf) }
    buf.push(line)
    // Trim in batches rather than shifting on every line once at cap, so a
    // busy service doesn't pay an O(n) cost per line.
    if (buf.length > LOG_CAP + LOG_TRIM_MARGIN) buf.splice(0, buf.length - LOG_CAP)
  }
  function getLogs(name, lines) {
    const buf = logBuffers.get(name) || []
    return lines ? buf.slice(-lines) : buf.slice()
  }

  // ── logging ──────────────────────────────────────────────────────────────
  // Routed through UI.write() so the same log()/warn() calls work before and
  // after the blessed screen exists (UI starts as a plain console.log shim so
  // setup steps that run before the UI attaches still print somewhere sane).
  let UI = { write: (_tab, line) => console.log(line), refreshStatus() {}, destroy() {} }
  const setUI = (ui) => { UI = ui }
  function emit(tab, line) {
    appendLog(tab, line)
    UI.write(tab, line)
  }
  const log = (...a) => emit('run-local', `[run-local] ${a.join(' ')}`)
  const warn = (...a) => emit('run-local', `[run-local] WARNING: ${a.join(' ')}`)

  // ── .env file ────────────────────────────────────────────────────────────
  function loadEnvFile(file) {
    if (!fs.existsSync(file)) return
    log(`loading ${file}`)
    for (let line of fs.readFileSync(file, 'utf8').split('\n')) {
      line = line.trim()
      if (!line || line.startsWith('#') || !line.includes('=')) continue
      const key = line.slice(0, line.indexOf('='))
      let value = line.slice(line.indexOf('=') + 1)
      value = value.replace(/^["']|["']$/g, '')
      if (process.env[key] === undefined) process.env[key] = value
    }
  }

  // ── shell helpers ────────────────────────────────────────────────────────
  const commandExists = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0

  // ── declarative conditions ────────────────────────────────────────────────
  // Shared by the config's `dependencies[]` and `warnings[]` — both are just
  // "evaluate a list of conditions, report a message if they're all true", so
  // one evaluator covers both instead of two ad-hoc ones. `${VAR}` /
  // `${VAR:-default}` in messages and in commandFails args are interpolated
  // from process.env.
  function interp(str) {
    return str.replace(/\$\{(\w+)(:-([^}]*))?\}/g, (_, name, _d, def) => process.env[name] ?? def ?? '')
  }

  function evalCondition(cond) {
    if ('envUnset' in cond) return !process.env[cond.envUnset]
    if ('envSet' in cond) return !!process.env[cond.envSet]
    if ('envNotIn' in cond) return !cond.envNotIn.values.includes(process.env[cond.envNotIn.var])
    if ('commandExists' in cond) return commandExists(cond.commandExists)
    if ('commandMissing' in cond) return !commandExists(cond.commandMissing)
    if ('commandFails' in cond) return spawnSync(interp(cond.commandFails.command), (cond.commandFails.args || []).map(interp)).status !== 0
    if ('included' in cond) return included(cond.included)
    if ('excluded' in cond) return isExcluded(cond.excluded)
    if ('anyIncluded' in cond) return cond.anyIncluded.some(included)
    return true
  }

  // Runs a one-off command to completion, streaming its output through the
  // same pipeline as services. Used for setup steps (mise, shortcut commands,
  // a oneShot service's onSuccess/onReady) — anything that isn't a
  // long-running server. Writes into the 'run-local' tab (with a colored
  // `[name]` prefix) by default; pass opts.tab to write into a specific
  // service's own tab instead (no prefix needed there — the tab itself
  // already says whose output it is).
  function runSync(name, command, cmdArgs, opts = {}) {
    const color = opts.color ?? 37
    const tab = opts.tab ?? 'run-local'
    const prefix = paint(color, `[${name}]`)
    const res = spawnSync(command, cmdArgs, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8' })
    for (const stream of [res.stdout, res.stderr]) {
      if (!stream) continue
      for (const line of stream.split('\n')) if (line) emit(tab, tab === 'run-local' ? `${prefix} ${line}` : line)
    }
    if (res.error) throw res.error
    return res.status ?? 1
  }

  // ── mise: pin java/node versions ──────────────────────────────────────────
  function setupMise() {
    if (!commandExists('mise')) {
      warn('mise not found — using system node/java, versions may drift between machines. For pinned versions (mise.toml): brew install mise')
      return
    }
    if (!fs.existsSync('mise.toml')) return
    log('mise: installing pinned tool versions from mise.toml')
    spawnSync('mise', ['trust', './mise.toml'])
    runSync('mise', 'mise', ['install'], { color: 90 })
    // Export the resolved tool paths into THIS process so child npm/gradle use
    // them even when the user hasn't run `mise activate` in their shell.
    const env = spawnSync('mise', ['env', '-s', 'bash'], { encoding: 'utf8' })
    if (env.status === 0) {
      for (const line of env.stdout.split('\n')) {
        const m = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))$/)
        if (m) process.env[m[1]] = (m[2] ?? m[3] ?? m[4] ?? '').replace(/\\(.)/g, '$1')
      }
    }
  }

  // ── dependency checks ──────────────────────────────────────────────────────
  // Driven entirely by the config's `dependencies[]` — add/change one there,
  // not here. Each entry is reported missing when every condition in `when`
  // is true (see evalCondition above).
  function checkDeps() {
    const missing = (config.dependencies || [])
      .filter((d) => (d.when || []).every(evalCondition))
      .map((d) => interp(d.message))
    if (missing.length) {
      console.error('Missing required dependencies:')
      for (const m of missing) console.error(`  - ${m}`)
      process.exit(1)
    }
    log('all required dependencies present')
  }

  // ── app warnings ───────────────────────────────────────────────────────────
  // Driven entirely by the config's `warnings[]` — add/change one there, not
  // here. Each warning fires when every condition in `when` is true
  // (empty/missing `when` → always fires).
  function printWarnings() {
    for (const w of config.warnings || []) {
      if (w.service && isExcluded(w.service)) continue
      if ((w.when || []).every(evalCondition)) warn(`${w.service ? `${w.service}: ` : ''}${interp(w.message)}`)
    }
  }

  // ── liveness ────────────────────────────────────────────────────────────
  function portOpen(host, port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port, timeout: 1000 })
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
      socket.on('timeout', () => { socket.destroy(); resolve(false) })
    })
  }

  async function checkLiveness(liveness) {
    if (liveness.type === 'port') return portOpen(liveness.host, liveness.port)
    if (liveness.type === 'http') {
      try { const res = await fetch(liveness.url, { signal: AbortSignal.timeout(2000) }); return res.ok } catch { return false }
    }
    if (liveness.type === 'command') return spawnSync('sh', ['-c', liveness.command]).status === 0
    return true
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const status = new Map() // name -> 'starting' | 'ready' | 'failed' | 'timeout'

  async function waitForLiveness(name, liveness) {
    const timeout = liveness.timeout ?? 300
    let waited = 0
    while (!(await checkLiveness(liveness))) {
      await sleep(1000)
      waited += 1
      if (waited % 15 === 0) log(`...still waiting for ${name} (${waited}s)`)
      if (waited >= timeout) { warn(`${name} did not become ready within ${timeout}s`); status.set(name, 'timeout'); UI.refreshStatus(); return }
    }
    log(`\u2713 ${name} ready`)
    status.set(name, 'ready')
    UI.refreshStatus()
  }

  // ── process orchestration ─────────────────────────────────────────────────
  const children = new Map() // name -> { proc, service, stopping }

  function serviceEnv(service) {
    const env = { ...process.env, ...(service.env || {}) }
    if (args.serviceLog) {
      env.LOGGING_FILE_NAME = process.env.LOGGING_FILE_NAME || args.serviceLog
      log(`${service.name}: also writing logs to ${env.LOGGING_FILE_NAME} (--service-log)`)
    }
    return env
  }

  function spawnService(service) {
    const color = colorFor(service.name)
    let logStream = null
    if (args.persistLogs) {
      fs.mkdirSync('logs', { recursive: true })
      logStream = fs.createWriteStream(`logs/${service.name}.log`, { flags: 'a' })
    }

    if (service.type === 'node' && !fs.existsSync(`${service.cwd}/node_modules`)) {
      log(`${service.name}: installing npm dependencies (first run)`)
      runSync(service.name, 'npm', ['install'], { cwd: service.cwd, color })
    }

    status.set(service.name, service.oneShot ? 'pending' : 'starting')
    UI.refreshStatus()
    const proc = spawn(service.command, service.args || [], {
      cwd: service.cwd,
      env: serviceEnv(service),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so we can kill the whole tree on restart/quit
    })
    const entry = { proc, service, stopping: false }
    children.set(service.name, entry)

    for (const stream of [proc.stdout, proc.stderr]) {
      readline.createInterface({ input: stream }).on('line', (line) => {
        emit(service.name, line)
        if (logStream) logStream.write(line + '\n')
      })
    }

    proc.on('exit', (code) => {
      if (logStream) logStream.end()
      if (entry.stopping) return // intentional restart/shutdown — not a crash
      if (service.oneShot) {
        status.set(service.name, code === 0 ? 'ready' : 'failed')
        UI.refreshStatus()
        if (code === 0 && service.onSuccess) {
          emit(service.name, `$ ${service.onSuccess}`)
          runSync(service.name, 'sh', ['-c', service.onSuccess], { cwd: process.cwd(), tab: service.name })
        }
        return
      }
      status.set(service.name, 'failed')
      UI.refreshStatus()
      warn(`${service.name} exited unexpectedly (code ${code})`)
    })

    // `ready` is what dependent services (see startService/`dependsOn` in
    // startAll()) await before starting:
    //  - liveness, if it has one (e.g. postgres becoming reachable, service's
    //    actuator health passing) — regardless of oneShot or long-running.
    //  - otherwise, for a oneShot job with no liveness (e.g. a build), just
    //    the process exiting.
    //  - otherwise (a long-running service with no liveness configured)
    //    there's no real readiness signal to wait for — resolve immediately
    //    rather than waiting on 'exit', which for a server that isn't
    //    supposed to exit would make any dependent hang forever.
    const ready = service.liveness
      ? waitForLiveness(service.name, service.liveness)
      : service.oneShot
        ? new Promise((resolve) => proc.on('exit', resolve))
        : Promise.resolve()

    // `onReady` (distinct from `onSuccess`) only fires once the service is
    // ACTUALLY ready — i.e. liveness passed, not just "the process exited".
    // E.g. `docker compose up -d` exits almost instantly, well before the
    // container inside is accepting connections; onSuccess would fire way too
    // early for anything that needs a real connection (e.g. seeding
    // roles/schemas). Only runs if status is truly 'ready' — skipped on a
    // liveness timeout/failure.
    const readyThen = ready.then(() => {
      if (service.onReady && status.get(service.name) === 'ready') {
        emit(service.name, `$ ${service.onReady}`)
        runSync(service.name, 'sh', ['-c', service.onReady], { cwd: process.cwd(), tab: service.name })
      }
    })
    return { proc, ready: readyThen }
  }

  function killService(name) {
    const entry = children.get(name)
    if (!entry) return Promise.resolve()
    entry.stopping = true
    return new Promise((resolve) => {
      entry.proc.once('exit', resolve)
      try { process.kill(-entry.proc.pid, 'SIGTERM') } catch { resolve() }
    })
  }

  async function restartService(name) {
    const service = config.services.find((s) => s.name === name)
    if (!service) return
    if (isExcluded(name)) { log(`${name} was excluded from this run (--exclude/--only) — nothing to restart`); return }
    if (children.has(name)) { log(`restarting ${name}...`); await killService(name) }
    else log(`starting ${name}...`)
    spawnService(service)
  }

  function runShortcut(shortcut) {
    if (shortcut.restart) return restartService(shortcut.restart)
    if (shortcut.command) {
      log(`running shortcut '${shortcut.key}': ${shortcut.command}`)
      return runSync(shortcut.key, 'sh', ['-c', shortcut.command], { cwd: shortcut.cwd, color: 90 })
    }
  }

  let quitting = false
  async function quit() {
    if (quitting) return
    quitting = true
    log('shutting down...')
    await Promise.all([...children.keys()].map(killService))
    UI.destroy()
  }

  // Starts every included service, respecting dependsOn order, and resolves
  // once they're all up (or have failed/timed out trying).
  async function startAll() {
    for (const dep of config.services.flatMap((s) => s.dependsOn || [])) {
      if (!ALL_NAMES.includes(dep)) warn(`config: dependsOn references unknown service '${dep}'`)
    }

    // readyPromises must be fully populated (one entry per included service)
    // BEFORE any startService() below runs its dependsOn wait — otherwise a
    // dependent that appears earlier in the array than its dependency would
    // call readyPromises.get(dep) while that entry doesn't exist yet, and
    // `await Promise.all([undefined])` resolves immediately instead of
    // actually waiting. Two passes: register every promise (via its
    // resolver) first, then kick off the real work.
    const includedServices = config.services.filter((s) => included(s.name))
    const readyPromises = new Map()
    const readyResolvers = new Map()
    for (const service of includedServices) {
      readyPromises.set(service.name, new Promise((resolve) => readyResolvers.set(service.name, resolve)))
    }

    async function startService(service) {
      const deps = (service.dependsOn || []).filter(included)
      if (deps.length) {
        log(`${service.name}: waiting for ${deps.join(', ')}...`)
        await Promise.all(deps.map((d) => readyPromises.get(d)))
      }
      log(service.note ? `starting ${service.name} (${service.note})` : `starting ${service.name}`)
      const { ready } = spawnService(service)
      await ready
      readyResolvers.get(service.name)()
    }
    for (const service of includedServices) startService(service)

    const shortcutHelp = (config.shortcuts || []).map((s) => `'${s.key}' ${s.label}`).join(', ')
    log(`all apps started — Ctrl+C to stop (or 'q'${shortcutHelp ? `; ${shortcutHelp}` : ''})`)
  }

  return {
    ALL_NAMES,
    included,
    isExcluded,
    colorFor,
    paint,
    log,
    warn,
    setUI,
    loadEnvFile,
    checkDeps,
    printWarnings,
    setupMise,
    status,
    children,
    spawnService,
    killService,
    restartService,
    runShortcut,
    getLogs,
    getStatusSnapshot: () => Object.fromEntries(status),
    quit,
    startAll,
  }
}

module.exports = { createEngine, STATE_COLOR, STATE_GLYPH }
