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

// Returns a human string ("first run"/"lockfile changed since last install")
// if a node service's deps need (re)installing, or null if node_modules
// looks up to date. Missing node_modules is the obvious case; the subtler
// one is a lockfile that's changed since the last install (deps
// added/bumped, node_modules never touched) — npm itself rewrites
// node_modules/.package-lock.json on every install to match whatever it just
// installed from, so it's the marker of "what node_modules currently
// reflects"; comparing its mtime against the repo lockfile's own catches a
// lockfile edited (checked out, merged, hand-edited) since that last install.
function npmInstallReason(cwd) {
  if (!fs.existsSync(`${cwd}/node_modules`)) return 'first run'
  const lockPath = ['package-lock.json', 'npm-shrinkwrap.json']
    .map((f) => `${cwd}/${f}`)
    .find((p) => fs.existsSync(p))
  if (!lockPath) return null // no lockfile to compare against — presence of node_modules is all we can check
  const installedLockPath = `${cwd}/node_modules/.package-lock.json`
  if (!fs.existsSync(installedLockPath)) return 'lockfile changed since last install'
  const lockMtime = fs.statSync(lockPath).mtimeMs
  const installedMtime = fs.statSync(installedLockPath).mtimeMs
  return lockMtime > installedMtime ? 'lockfile changed since last install' : null
}

function createEngine({ config, args }) {
  // ALL_NAMES/includedSet are mutated in place (never reassigned) by
  // reloadConfig() below, specifically so every closure that captured them
  // here (colorFor, included, isExcluded, and everything built on those)
  // keeps working post-reload without needing to re-derive anything itself.
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
  // Total lines ever appended per tab, monotonic and unaffected by the
  // ring-buffer trimming above (unlike buf.length) — lets a polling attach
  // client (lib/attach-client.js) ask "everything since line N" without
  // re-fetching the whole buffer every tick. See getLogsSince below.
  const logTotals = new Map()
  function appendLog(name, line) {
    let buf = logBuffers.get(name)
    if (!buf) { buf = []; logBuffers.set(name, buf) }
    buf.push(line)
    logTotals.set(name, (logTotals.get(name) || 0) + 1)
    // Trim in batches rather than shifting on every line once at cap, so a
    // busy service doesn't pay an O(n) cost per line.
    if (buf.length > LOG_CAP + LOG_TRIM_MARGIN) buf.splice(0, buf.length - LOG_CAP)
  }
  function getLogs(name, lines) {
    const buf = logBuffers.get(name) || []
    return lines ? buf.slice(-lines) : buf.slice()
  }
  // Cursor-based tailing: returns only the lines appended after `since` (a
  // `total` from a previous call), plus the new `total` to pass in next
  // time. If the caller fell behind further than what's still in the ring
  // buffer, falls back to the whole current buffer — some lines were
  // necessarily lost to trimming in that case, which is an acceptable
  // tradeoff for a dev tool's polling display, not a data contract.
  function getLogsSince(name, since = 0) {
    const buf = logBuffers.get(name) || []
    const total = logTotals.get(name) || 0
    const missed = Math.max(0, total - since)
    return { lines: missed >= buf.length ? buf.slice() : buf.slice(buf.length - missed), total }
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
  const status = new Map() // name -> 'pending' | 'starting' | 'ready' | 'failed' | 'timeout'

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

  // Minimal KEY=VALUE parser — no quoting/multiline/export support, just
  // enough for a typical .env: blank lines and #-comments skipped, one
  // unquoted-or-quoted value per line. Missing file is a no-op (most repos'
  // .env is gitignored, so its absence shouldn't crash the whole stack) —
  // anything else (e.g. a directory at that path) surfaces as a warning.
  const envFileCache = new Map() // path -> parsed object, so N services sharing one envFile only read/parse it once
  function parseEnvFile(filePath) {
    if (envFileCache.has(filePath)) return envFileCache.get(filePath)
    let parsed = {}
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        parsed[key] = value
      }
    } catch (err) {
      if (err.code !== 'ENOENT') warn(`envFile '${filePath}' could not be read: ${err.message}`)
    }
    envFileCache.set(filePath, parsed)
    return parsed
  }

  function serviceEnv(service) {
    const fileEnv = service.envFile ? parseEnvFile(service.envFile) : {}
    const env = { ...process.env, ...fileEnv, ...(service.env || {}) }
    if (args.serviceLog) {
      env.LOGGING_FILE_NAME = process.env.LOGGING_FILE_NAME || args.serviceLog
      log(`${service.name}: also writing logs to ${env.LOGGING_FILE_NAME} (--service-log)`)
    }
    return env
  }

  // name -> consecutive crash count, used for autoRestart's backoff — reset
  // by spawnService's upTimer once a respawned instance stays up 10s.
  const restartAttempts = new Map()
  const pendingRestarts = new Map() // name -> timer, cleared on quit() so a scheduled respawn can't fire after shutdown
  function scheduleAutoRestart(service) {
    if (quitting || isExcluded(service.name)) return
    const attempts = (restartAttempts.get(service.name) || 0) + 1
    restartAttempts.set(service.name, attempts)
    const delayMs = Math.min(30000, 1000 * 2 ** (attempts - 1)) // 1s, 2s, 4s, ... capped at 30s
    log(`${service.name}: autoRestart — retrying in ${delayMs / 1000}s (attempt ${attempts})`)
    const timer = setTimeout(() => {
      pendingRestarts.delete(service.name)
      if (quitting || isExcluded(service.name)) return
      spawnService(service)
    }, delayMs)
    pendingRestarts.set(service.name, timer)
  }

  function spawnService(service) {
    const color = colorFor(service.name)
    let logStream = null
    if (args.persistLogs) {
      fs.mkdirSync('logs', { recursive: true })
      logStream = fs.createWriteStream(`logs/${service.name}.log`, { flags: 'a' })
    }

    if (service.type === 'node') {
      const reason = npmInstallReason(service.cwd)
      if (reason) {
        log(`${service.name}: installing npm dependencies (${reason})`)
        runSync(service.name, 'npm', ['install'], { cwd: service.cwd, color })
      }
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
    // Surviving 10s wipes the crash-loop counter — a service that's been
    // fine for a while and then crashes once shouldn't inherit backoff from
    // an unrelated flurry of crashes hours/days earlier.
    const upTimer = setTimeout(() => restartAttempts.delete(service.name), 10000)

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
      clearTimeout(upTimer)
      if (service.autoRestart) scheduleAutoRestart(service)
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
    if (children.has(name)) {
      log(`restarting ${name}...`)
      status.set(name, 'pending')
      UI.refreshStatus()
      await killService(name)
    } else {
      log(`starting ${name}...`)
    }
    spawnService(service)
  }

  function runShortcut(shortcut) {
    if (shortcut.restart) return restartService(shortcut.restart)
    if (shortcut.command) {
      log(`running shortcut '${shortcut.key}': ${shortcut.command}`)
      return runSync(shortcut.key, 'sh', ['-c', shortcut.command], { cwd: shortcut.cwd, color: 90 })
    }
  }

  // Swaps in a freshly re-read (and already schema-validated — see
  // bin/vibestackr's reload handler, which is what actually re-reads the
  // file) config without restarting the daemon. `config` itself is mutated
  // in place (Object.assign), not reassigned, since it's the exact object
  // reference every closure in this file (checkDeps/printWarnings/
  // runShortcut/control-socket's own 'shortcuts'+'services' handlers/etc)
  // already captured — mutating it means all of those see the new
  // dependencies/warnings/shortcuts/services immediately, with no need to
  // thread a reload event through every one of them individually.
  //
  // Newly-added included services get started right away. A service that's
  // been removed from config (or excluded by the same --exclude/--only this
  // daemon was started with) is deliberately left running rather than
  // auto-killed — reloading a config typo shouldn't be able to tear down a
  // service someone's actively relying on; restart_service/`vibestackr stop`
  // remain the explicit ways to actually stop something.
  //
  // What this does NOT do: any already-running service whose command/env/
  // liveness/etc changed keeps running with its OLD settings until manually
  // restarted (via restart_service or its shortcut) — this is a config
  // reload, not a rolling redeploy, and no consumer here can tell "changed"
  // from "same" without a needless diff of every service field.
  function reloadConfig(newConfig) {
    const oldNames = new Set(config.services.map((s) => s.name))
    for (const key of Object.keys(config)) delete config[key]
    Object.assign(config, newConfig)

    ALL_NAMES.length = 0
    ALL_NAMES.push(...config.services.map((s) => s.name))
    includedSet.clear()
    for (const name of resolveIncludedSet(config, args)) includedSet.add(name)

    for (const service of config.services) {
      if (included(service.name) && !oldNames.has(service.name) && !children.has(service.name)) {
        log(`${service.name}: new in reloaded config — starting`)
        spawnService(service)
      }
    }
    const newNames = new Set(config.services.map((s) => s.name))
    for (const name of oldNames) {
      if (!newNames.has(name) && children.has(name)) {
        warn(`${name} was removed from config but is still running — restart_service won't find it anymore; stop it via its own process, or 'vibestackr stop' to clear everything`)
      }
    }
    UI.refreshStatus()
    log('config reloaded')
  }

  let quitting = false
  async function quit() {
    if (quitting) return
    quitting = true
    log('shutting down...')
    for (const timer of pendingRestarts.values()) clearTimeout(timer)
    pendingRestarts.clear()
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
      // Set before any dependsOn wait below — a service queued behind an
      // unfinished dependency has no entry in `status` yet otherwise, so it's
      // invisible to countStatuses()/getStatusSnapshot() (neither up, pending,
      // nor down) until its own spawnService() finally runs.
      status.set(service.name, 'pending')
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
    reloadConfig,
    getLogs,
    getLogsSince,
    getStatusSnapshot: () => Object.fromEntries(status),
    quit,
    startAll,
  }
}

module.exports = { createEngine, STATE_COLOR, STATE_GLYPH }
