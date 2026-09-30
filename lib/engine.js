'use strict'

// The orchestration engine: process lifecycle, liveness, declarative
// dependency/warning checks, and log capture. No blessed/UI code here — the
// TUI (lib/ui.js) is one consumer of this engine's state; a future MCP
// server is another. Neither goes through the other.

const { spawn, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const { discoverJobs } = require('./job-discovery')
const { splitStream, splitText } = require('./line-splitter')

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

// Same "first run"/"changed since last install" distinction as
// npmInstallReason above, for toolchains (go/python/rust) that have no
// node_modules-equivalent local install directory to check the presence of
// directly — their actual caches live outside the project (GOPATH/pkg/mod,
// ~/.cargo, a venv that may not even be project-local). Instead we drop our
// own marker file after a successful install and compare its mtime against
// the toolchain's manifest file, same as node_modules/.package-lock.json
// does for npm.
function markerInstallReason(cwd, manifestFiles, markerRelPath) {
  const manifestPath = manifestFiles.map((f) => `${cwd}/${f}`).find((p) => fs.existsSync(p))
  if (!manifestPath) return null // no manifest for this toolchain in this service's cwd — nothing to install
  const markerPath = `${cwd}/${markerRelPath}`
  if (!fs.existsSync(markerPath)) return 'first run'
  return fs.statSync(manifestPath).mtimeMs > fs.statSync(markerPath).mtimeMs ? 'manifest changed since last install' : null
}

// go.sum, if present, is the one that actually changes when dependencies are
// added/bumped — go.mod alone can be edited (e.g. a new require line) before
// `go mod tidy` regenerates it, so prefer go.sum when both exist.
function goInstallReason(cwd) {
  return markerInstallReason(cwd, ['go.sum', 'go.mod'], '.vibestackr-go-installed')
}

function rustInstallReason(cwd) {
  return markerInstallReason(cwd, ['Cargo.lock', 'Cargo.toml'], '.vibestackr-rust-installed')
}

function pythonInstallReason(cwd) {
  return markerInstallReason(cwd, ['uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.txt', 'pyproject.toml'], '.vibestackr-python-installed')
}

// Picks the install command based on whichever Python dependency manifest is
// actually present, in order of most-specific-lockfile first — uv.lock/
// poetry.lock/Pipfile.lock each pin exact versions the way package-lock.json
// does, so prefer that tool's own install over a looser `pip install -r`
// when a lockfile and a requirements.txt happen to coexist. uv.lock takes
// priority over poetry.lock/Pipfile.lock if somehow more than one is
// present, since a project that's set up `uv` at all has already opted into
// it as the one actually driving installs.
function pythonInstallCommand(cwd, extra) {
  if (fs.existsSync(`${cwd}/uv.lock`)) {
    return { command: 'uv', args: ['sync', ...(extra || []).flatMap((e) => ['--extra', e])] }
  }
  if (fs.existsSync(`${cwd}/poetry.lock`)) {
    return { command: 'poetry', args: ['install', ...(extra || []).flatMap((e) => ['--with', e])] }
  }
  if (fs.existsSync(`${cwd}/Pipfile.lock`)) return { command: 'pipenv', args: ['install'] }
  if (fs.existsSync(`${cwd}/requirements.txt`)) return { command: 'pip', args: ['install', '-r', 'requirements.txt'] }
  // only a pyproject.toml with no lockfile — poetry install both resolves and locks
  return { command: 'poetry', args: ['install', ...(extra || []).flatMap((e) => ['--with', e])] }
}

// Runs each type's install step (if its reason() says one is due), then
// drops the marker file reason() checks against next time — node is handled
// separately above since node_modules/.package-lock.json already serves as
// its own marker, no synthetic file needed.
const INSTALL_STEPS = {
  go: { reason: goInstallReason, marker: '.vibestackr-go-installed', label: 'go module', build: () => ({ command: 'go', args: ['mod', 'download'] }) },
  rust: { reason: rustInstallReason, marker: '.vibestackr-rust-installed', label: 'cargo', build: (cwd, service) => ({ command: 'cargo', args: ['fetch', ...(service.install && service.install.features || []).flatMap((f) => ['--features', f])] }) },
  python: { reason: pythonInstallReason, marker: '.vibestackr-python-installed', label: 'python', build: (cwd, service) => pythonInstallCommand(cwd, service.install && service.install.extra) },
}

// Shell-quotes an interactive shortcut's input value before substituting it
// into a `sh -c` command string — single-quoted, with any embedded single
// quote escaped the standard '\'' way, so a value (typed by a human in the
// TUI, or supplied by an agent over MCP) can never break out of its
// placeholder and inject additional shell syntax.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

// Substitutes `${name}` in an interactive shortcut's `command` with the
// value collected for that input (or its own `default` if none was given).
// Same `${...}` syntax as interp() above (env-var interpolation for
// dependencies[]/warnings[]), for familiarity, but sourced from `values`
// (whatever the TUI's input popover or the MCP run_shortcut tool passed
// through) rather than process.env.
// `options` entries may be a bare string or `{ value, label }` (see
// schema/config.schema.json) — normalized once here so the TUI dropdown,
// list_shortcuts and validation below never each re-handle both shapes.
function normalizeInputOptions(input) {
  if (!input.options) return null
  return input.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value }))
}

function interpolateShortcutInputs(command, inputs, values) {
  if (!inputs || !inputs.length) return command
  let result = command
  for (const input of inputs) {
    const options = normalizeInputOptions(input)
    const raw = options
      ? values?.[input.name] || input.default || options[0].value
      : values?.[input.name] ?? input.default ?? ''
    // The TUI can only ever submit a listed value, but an MCP run_shortcut
    // call can pass anything — `options` is a whitelist, not a suggestion.
    if (options && !options.some((o) => o.value === raw)) {
      throw new Error(`input '${input.name}' must be one of: ${options.map((o) => o.value).join(', ')} (got '${raw}')`)
    }
    result = result.split(`\${${input.name}}`).join(shellQuote(raw))
  }
  return result
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
  // `partial` rides along on the same response (not a separate method) so
  // it's always consistent with `lines` — a line that just committed can't
  // show up both as a new line and still as the in-progress one.
  function getLogsSince(name, since = 0) {
    const buf = logBuffers.get(name) || []
    const total = logTotals.get(name) || 0
    const missed = Math.max(0, total - since)
    return { lines: missed >= buf.length ? buf.slice() : buf.slice(buf.length - missed), total, partial: getPartial(name) }
  }

  // In-progress (no `\n` yet) line per stream writing into a tab — see
  // lib/line-splitter.js. Keyed per stream *object*, not stdout/stderr slot:
  // on restart the old process's streams can still be flushing their final
  // end() after the new process has started writing, and must only ever
  // clear their own entry, never the new process's.
  //
  // Returns retire(): called on the owning process's exit, it drops this
  // stream's partial and ignores any later ones. A stream's own 'end' isn't
  // enough — a grandchild in the same process group that outlives a kill
  // (a JVM running shutdown hooks, a draining node server) still holds the
  // pipe open, so a restarted service would show the dead process's
  // in-progress line alongside the new one's. Committed lines still flow.
  const logPartials = new Map() // tab -> Map(stream -> string)
  function streamLines(tab, stream, onLine) {
    let retired = false
    const clear = () => {
      const byStream = logPartials.get(tab)
      if (!byStream) return
      byStream.delete(stream)
      if (!byStream.size) logPartials.delete(tab)
    }
    splitStream(stream, {
      onLine,
      onPartial: (text) => {
        if (text === null || retired) return clear()
        if (!logPartials.has(tab)) logPartials.set(tab, new Map())
        logPartials.get(tab).set(stream, text)
      },
    })
    return () => { retired = true; clear() }
  }
  const getPartial = (name) => [...(logPartials.get(name)?.values() || [])]

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
  // Keys this function itself put into process.env — so a reload (overwrite:
  // true) can also *unset* one deleted from the file since, without ever
  // touching a var that came from the user's own shell instead.
  const envFileKeys = new Map() // file -> Set(key)
  const shellEnv = { ...process.env } // what an unset key falls back to
  function loadEnvFile(file, { overwrite = false } = {}) {
    const previous = envFileKeys.get(file) || new Set()
    const current = new Set()
    if (fs.existsSync(file)) {
      log(`loading ${file}`)
      for (let line of fs.readFileSync(file, 'utf8').split('\n')) {
        line = line.trim()
        if (!line || line.startsWith('#') || !line.includes('=')) continue
        const key = line.slice(0, line.indexOf('='))
        let value = line.slice(line.indexOf('=') + 1)
        value = value.replace(/^["']|["']$/g, '')
        if (overwrite || process.env[key] === undefined || previous.has(key)) {
          process.env[key] = value
          current.add(key)
        }
      }
    }
    for (const key of previous) {
      if (current.has(key)) continue
      if (key in shellEnv) process.env[key] = shellEnv[key]
      else delete process.env[key]
    }
    envFileKeys.set(file, current)
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
      splitText(stream, (line) => { if (line) emit(tab, tab === 'run-local' ? `${prefix} ${line}` : line) })
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

  // ── one-off jobs (auto-discovered npm/make/gradle/python scripts) ─────────
  // Distinct from `children`/`status` above: a job isn't a long-lived
  // service — no install step, liveness, oneShot bookkeeping, or
  // autoRestart, just spawn-stream-exit. Each run gets its own tab key (see
  // runJob below) so a rerun's output never bleeds into a previous run's.
  const jobs = new Map() // tab -> { proc, service, jobId }
  const jobStatus = new Map() // tab -> 'running' | 'succeeded' | 'failed:<code>'
  let jobCounter = 0

  function discoverJobsForService(name) {
    const service = config.services.find((s) => s.name === name)
    if (!service) throw new Error(`no service named '${name}'`)
    return discoverJobs(service)
  }

  function discoverAllJobs() {
    return config.services.map((s) => ({ name: s.name, jobs: discoverJobs(s) }))
  }

  function runJob(serviceName, jobId) {
    const service = config.services.find((s) => s.name === serviceName)
    if (!service) throw new Error(`no service named '${serviceName}'`)
    const job = discoverJobs(service).find((j) => j.id === jobId)
    if (!job) throw new Error(`no job '${jobId}' discovered for service '${serviceName}'`)

    const tab = `job:${serviceName}:${jobId}:${++jobCounter}`
    jobStatus.set(tab, 'running')
    const proc = spawn(job.command, job.args, {
      cwd: service.cwd,
      env: serviceEnv(service),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    jobs.set(tab, { proc, service, jobId })
    let failedToSpawn = false
    // Same ENOENT-on-'error'-not-'exit' hazard as spawnService above — a bad
    // job command must fail just this job's tab, not the daemon.
    proc.on('error', (err) => {
      failedToSpawn = true
      emit(tab, `[${jobId}] failed to start: ${err.message}`)
      jobStatus.set(tab, `failed:${err.code || 'error'}`)
    })
    const retirers = [proc.stdout, proc.stderr].map((stream) => streamLines(tab, stream, (line) => emit(tab, line)))
    for (const ev of ['exit', 'error']) proc.on(ev, () => retirers.forEach((retire) => retire()))
    proc.on('exit', (code) => {
      if (failedToSpawn) return
      jobStatus.set(tab, code === 0 ? 'succeeded' : `failed:${code}`)
    })
    return tab
  }

  function getJobStatus(tab) {
    return jobStatus.get(tab) ?? null
  }

  // Minimal KEY=VALUE parser — no quoting/multiline/export support, just
  // enough for a typical .env: blank lines and #-comments skipped, one
  // unquoted-or-quoted value per line. Missing file is a no-op (most repos'
  // .env is gitignored, so its absence shouldn't crash the whole stack) —
  // anything else (e.g. a directory at that path) surfaces as a warning.
  //
  // Cached per path so N services sharing one envFile don't each re-parse
  // it — but keyed on mtime+size, never forever: a cache that outlived an
  // edit meant a restarted service (or a rerun job) silently kept the old
  // values, which is exactly when someone edits a .env.
  const envFileCache = new Map() // path -> { mtimeMs, size, parsed }
  function parseEnvFile(filePath) {
    let stat
    try { stat = fs.statSync(filePath) } catch (err) {
      if (err.code !== 'ENOENT') warn(`envFile '${filePath}' could not be read: ${err.message}`)
      return {}
    }
    const cached = envFileCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.parsed
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
    envFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed })
    return parsed
  }

  // Pure (no logging) so reloadConfig can recompute it for comparison — see
  // spawnFingerprint below.
  function buildServiceEnv(service) {
    const fileEnv = service.envFile ? parseEnvFile(service.envFile) : {}
    const env = { ...process.env, ...fileEnv, ...(service.env || {}) }
    if (args.serviceLog) env.LOGGING_FILE_NAME = process.env.LOGGING_FILE_NAME || args.serviceLog
    return env
  }
  // Everything that actually shapes a spawned process — what reloadConfig
  // compares to decide whether a running service is stale. The *resolved*
  // env (process.env + envFile contents + env{}), not the config's env{}
  // alone, so an edited envFile or root .env counts as a change too, not
  // just an edited .vibestackr.yaml. Display/orchestration-only fields
  // (note, liveness, jsonLog, dependsOn...) deliberately don't: changing
  // those shouldn't bounce a running process.
  function spawnFingerprint(service, env = buildServiceEnv(service)) {
    const sortedEnv = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return crypto.createHash('sha1').update(JSON.stringify([service.command, service.args || [], service.cwd ?? null, sortedEnv])).digest('hex')
  }

  function serviceEnv(service) {
    const env = buildServiceEnv(service)
    if (args.serviceLog) log(`${service.name}: also writing logs to ${env.LOGGING_FILE_NAME} (--service-log)`)
    return env
  }

  // name -> consecutive crash count, used for autoRestart's backoff — reset
  // by spawnService's upTimer once a respawned instance stays up 10s.
  const restartAttempts = new Map()
  const pendingRestarts = new Map() // name -> timer, cleared on quit() so a scheduled respawn can't fire after shutdown
  // A running process's handlers closed over the `service` object it was
  // spawned from — after a reloadConfig that's a stale copy. Anything read
  // at exit time (autoRestart) or used to respawn must come from the live
  // config instead, or e.g. reloading `autoRestart: true` silently wouldn't
  // apply to the process already running.
  const currentService = (service) => config.services.find((s) => s.name === service.name) ?? service

  function scheduleAutoRestart(service) {
    if (quitting || isExcluded(service.name)) return
    const attempts = (restartAttempts.get(service.name) || 0) + 1
    restartAttempts.set(service.name, attempts)
    const delayMs = Math.min(30000, 1000 * 2 ** (attempts - 1)) // 1s, 2s, 4s, ... capped at 30s
    log(`${service.name}: autoRestart — retrying in ${delayMs / 1000}s (attempt ${attempts})`)
    const timer = setTimeout(() => {
      pendingRestarts.delete(service.name)
      if (quitting || isExcluded(service.name)) return
      spawnService(currentService(service))
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

    // Install-step failures (most commonly the install tool itself missing —
    // ENOENT — but also a non-zero exit) must not take down the whole daemon
    // over one bad service: catch here, mark just this service 'failed', and
    // leave the other services to start normally.
    try {
      if (service.type === 'node') {
        const reason = npmInstallReason(service.cwd)
        if (reason) {
          log(`${service.name}: installing npm dependencies (${reason})`)
          const omitArgs = (service.install && service.install.omit || []).map((o) => `--omit=${o}`)
          runSync(service.name, 'npm', ['install', ...omitArgs], { cwd: service.cwd, color })
        }
      } else if (INSTALL_STEPS[service.type]) {
        const step = INSTALL_STEPS[service.type]
        const reason = step.reason(service.cwd)
        if (reason) {
          log(`${service.name}: installing ${step.label} dependencies (${reason})`)
          const { command, args: cmdArgs } = step.build(service.cwd, service)
          runSync(service.name, command, cmdArgs, { cwd: service.cwd, color })
          fs.writeFileSync(`${service.cwd}/${step.marker}`, '')
        }
      }
    } catch (err) {
      warn(`${service.name}: install step failed (${err.message}) — not starting`)
      status.set(service.name, 'failed')
      UI.refreshStatus()
      return
    }

    status.set(service.name, service.oneShot ? 'pending' : 'starting')
    UI.refreshStatus()
    const env = serviceEnv(service)
    const proc = spawn(service.command, service.args || [], {
      cwd: service.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so we can kill the whole tree on restart/quit
    })
    const entry = { proc, service, stopping: false, fingerprint: spawnFingerprint(service, env) }
    children.set(service.name, entry)
    // Surviving 10s wipes the crash-loop counter — a service that's been
    // fine for a while and then crashes once shouldn't inherit backoff from
    // an unrelated flurry of crashes hours/days earlier.
    const upTimer = setTimeout(() => restartAttempts.delete(service.name), 10000)

    // Ended on the child's 'close' (below), not 'exit': 'exit' can fire while
    // stdout/stderr are still draining, and a final unterminated line only
    // commits on its stream's 'end' — ending the file on 'exit' dropped that
    // line from --persist-logs while the ring buffer still got it.
    const endLog = () => { if (logStream && !logStream.writableEnded) logStream.end() }
    proc.on('close', endLog)

    let failedToSpawn = false
    // A bad `command` (typo, missing binary — ENOENT) fires 'error', not
    // 'exit' — without this listener that's an unhandled event and takes the
    // whole daemon process down with it, not just this one service.
    proc.on('error', (err) => {
      failedToSpawn = true
      endLog()
      warn(`${service.name}: failed to start (${err.message})`)
      status.set(service.name, 'failed')
      UI.refreshStatus()
      clearTimeout(upTimer)
      if (currentService(service).autoRestart) scheduleAutoRestart(service)
    })

    const retirers = [proc.stdout, proc.stderr].map((stream) => streamLines(service.name, stream, (line) => {
      emit(service.name, line)
      // Belt and braces: a write-after-end is an 'error' event nothing
      // listens for, i.e. a daemon crash.
      if (logStream && !logStream.writableEnded) logStream.write(line + '\n')
    }))
    for (const ev of ['exit', 'error']) proc.on(ev, () => retirers.forEach((retire) => retire()))

    proc.on('exit', (code) => {
      if (failedToSpawn) return // 'error' above already handled this
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
      if (currentService(service).autoRestart) scheduleAutoRestart(service)
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

  // service.stopCommand covers anything that outlives the spawned process
  // itself — e.g. `docker run -d ...` (oneShot) exits almost instantly, but
  // the container it started keeps running completely independent of that
  // process; SIGTERM-ing an already-exited process's group (below) does
  // nothing to it. Runs regardless of whether the process itself needed
  // killing, since a oneShot service's process may already be long gone.
  function runStopCommand(entry) {
    if (!entry.service.stopCommand) return
    emit(entry.service.name, `$ ${entry.service.stopCommand}`)
    spawnSync('sh', ['-c', entry.service.stopCommand], { cwd: entry.service.cwd })
  }

  function killService(name) {
    const entry = children.get(name)
    if (!entry) return Promise.resolve()
    entry.stopping = true
    return new Promise((resolve) => {
      entry.proc.once('exit', () => { runStopCommand(entry); resolve() })
      try { process.kill(-entry.proc.pid, 'SIGTERM') } catch { runStopCommand(entry); resolve() }
    })
  }

  // Serialized per service: two overlapping restarts (a double-pressed
  // shortcut, two reloads, a reload during an MCP restart_service) used to
  // each await the same kill and then each spawn a replacement — one of
  // them untracked in `children`, i.e. an orphan nobody could stop. Chained,
  // the second one just restarts the first one's (already current) process.
  const restartChains = new Map() // name -> tail promise of queued restarts
  function restartService(name) {
    const run = (restartChains.get(name) || Promise.resolve()).then(() => restartNow(name))
    const tail = run.catch(() => {})
    restartChains.set(name, tail)
    tail.then(() => { if (restartChains.get(name) === tail) restartChains.delete(name) })
    return run
  }
  async function restartNow(name) {
    const service = config.services.find((s) => s.name === name)
    if (!service) return
    if (isExcluded(name)) { log(`${name} was excluded from this run (--exclude/--only) — nothing to restart`); return }
    // A pending autoRestart backoff timer would otherwise fire later and
    // spawn a second copy alongside the one started here.
    if (pendingRestarts.has(name)) { clearTimeout(pendingRestarts.get(name)); pendingRestarts.delete(name) }
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

  function runShortcut(shortcut, values = {}) {
    if (shortcut.restart) {
      const names = Array.isArray(shortcut.restart) ? shortcut.restart : [shortcut.restart]
      return Promise.all(names.map((name) => restartService(name)))
    }
    if (shortcut.service && shortcut.job) {
      log(`running shortcut '${shortcut.key}': job '${shortcut.job}' in '${shortcut.service}'`)
      return { tab: runJob(shortcut.service, shortcut.job) }
    }
    if (shortcut.jobs) {
      const tabs = shortcut.jobs.map(({ service, job }) => {
        log(`running shortcut '${shortcut.key}': job '${job}' in '${service}'`)
        return runJob(service, job)
      })
      return { tabs }
    }
    if (shortcut.command) {
      const command = interpolateShortcutInputs(shortcut.command, shortcut.inputs, values)
      log(`running shortcut '${shortcut.key}': ${command}`)
      return runSync(shortcut.key, 'sh', ['-c', command], { cwd: shortcut.cwd, color: 90 })
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
  // A running long-lived service whose spawnFingerprint changed (command/
  // args/cwd, or its resolved env — including an edited envFile or root
  // .env, which the caller re-reads first) is restarted, so the reload
  // actually takes effect: a stale env surviving a reload was the whole
  // complaint. Its stopCommand runs as part of that restart. No build-daemon
  // handling (e.g. `gradle --stop`) is needed or wanted here: Gradle applies
  // the client's current env to a reused daemon on every build (verified on
  // 9.x — config-time reads, forked Exec/JavaExec, configuration cache all
  // see the new value) and spawns a new daemon itself on JVM-arg/JAVA_HOME
  // changes, while `--stop` would kill every daemon of that version
  // machine-wide, the IDE's included. A oneShot service is deliberately NOT re-run even if changed —
  // re-running a migration or `docker run -d` as a side effect of a reload
  // is too surprising; it's reported so it can be restarted by hand.
  //
  // Async, and serialized: each reload awaits its own restarts before the
  // next one diffs anything — otherwise a second reload arriving mid-kill
  // still sees the old process's fingerprint and restarts it all over again.
  let reloadChain = Promise.resolve()
  function reloadConfig(newConfig) {
    const run = reloadChain.then(() => applyReload(newConfig))
    reloadChain = run.catch(() => {})
    return run
  }
  async function applyReload(newConfig) {
    const oldNames = new Set(config.services.map((s) => s.name))
    for (const key of Object.keys(config)) delete config[key]
    Object.assign(config, newConfig)

    ALL_NAMES.length = 0
    ALL_NAMES.push(...config.services.map((s) => s.name))
    includedSet.clear()
    for (const name of resolveIncludedSet(config, args)) includedSet.add(name)

    const summary = { started: [], restarted: [], changedOneShot: [] }
    const restarts = []
    for (const service of config.services) {
      if (!included(service.name)) continue
      const entry = children.get(service.name)
      if (!oldNames.has(service.name) && !entry) {
        log(`${service.name}: new in reloaded config — starting`)
        spawnService(service)
        summary.started.push(service.name)
      } else if (entry && entry.fingerprint !== spawnFingerprint(service)) {
        if (service.oneShot) {
          warn(`${service.name}: command/env changed, but it's oneShot so it wasn't re-run — restart it to apply`)
          summary.changedOneShot.push(service.name)
        } else {
          log(`${service.name}: command/env changed — restarting`)
          restarts.push(restartService(service.name))
          summary.restarted.push(service.name)
        }
      }
    }
    const newNames = new Set(config.services.map((s) => s.name))
    for (const name of oldNames) {
      if (!newNames.has(name) && children.has(name)) {
        warn(`${name} was removed from config but is still running — restart_service won't find it anymore; stop it via its own process, or 'vibestackr stop' to clear everything`)
      }
    }
    await Promise.all(restarts)
    UI.refreshStatus()
    log('config reloaded')
    return summary
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
    getPartial,
    getStatusSnapshot: () => Object.fromEntries(status),
    discoverJobsForService,
    discoverAllJobs,
    runJob,
    getJobStatus,
    quit,
    startAll,
  }
}

module.exports = { createEngine, STATE_COLOR, STATE_GLYPH, goInstallReason, rustInstallReason, pythonInstallReason, pythonInstallCommand, interpolateShortcutInputs, normalizeInputOptions }
