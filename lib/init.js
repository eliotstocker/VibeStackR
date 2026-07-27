'use strict'

// `vibestakr init` — agent-assisted config generation. Builds a prompt that
// embeds the JSON Schema + an annotated example and instructs an agent to
// inspect the target repo and produce a valid .vibestakr.json, then hands
// that prompt to whichever coding CLI it finds first on PATH. Falls
// back to printing (and pbcopy-ing, on macOS) the prompt if none are found —
// this repo has no way to know every user's installed toolchain, so a manual
// paste-into-your-tool-of-choice path always has to exist.

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { spawn, spawnSync } = require('child_process')
const commandLineArgs = require('command-line-args')
const { loadConfig, CANDIDATES } = require('./config')
const { LOGO_ANSI, gradientAnsiAt } = require('./logo')

const AGENTS_MD_START = '<!-- vibestakr:start -->'
const AGENTS_MD_END = '<!-- vibestakr:end -->'
const AGENT_HEARTBEAT_MS = 15000
const AGENT_TIMEOUT_MS = 10 * 60 * 1000

const EXAMPLE_CONFIG = `{
  "name": "MyApp",
  "services": [
    {
      "name": "postgres",
      "type": "docker",
      "cwd": ".",
      "command": "sh",
      "args": ["-c", "docker start myapp-postgres 2>/dev/null || docker run -d --name myapp-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:16"],
      "note": "docker run, port 5432",
      "oneShot": true,
      "liveness": { "type": "command", "command": "docker exec myapp-postgres pg_isready -U postgres", "timeout": 30 }
    },
    {
      "name": "api",
      "type": "node",
      "cwd": "api",
      "command": "npm",
      "args": ["run", "dev"],
      "note": "http://localhost:4000",
      "watcher": true,
      "dependsOn": ["postgres"],
      "liveness": { "type": "http", "url": "http://localhost:4000/health" }
    },
    {
      "name": "web",
      "type": "node",
      "cwd": "web",
      "command": "npm",
      "args": ["run", "dev"],
      "note": "http://localhost:5173",
      "dependsOn": ["api"],
      "liveness": { "type": "port", "host": "localhost", "port": 5173 }
    }
  ],
  "dependencies": [
    { "message": "docker (install: brew install --cask docker)", "when": [{ "commandMissing": "docker" }] }
  ],
  "shortcuts": [
    { "key": "r", "label": "restart api", "restart": "api" }
  ],
  "warnings": []
}`

function buildPrompt(root) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema', 'run-local.config.schema.json'), 'utf8')
  return `You're setting up vibestakr for this repository. vibestakr is a TUI that brings up a local dev stack (multiple services, in dependency order, with liveness checks) from a single config file: .vibestakr.json (or .vibestakr/.vibestakr.yaml/.vibestakr.yml) in the project root.

Your job: inspect this repository (package.json scripts, docker-compose files, existing dev/README scripts, Dockerfiles, .env.example, etc.) and write a valid .vibestakr.json at the project root describing how to run its full local dev stack.

Scope: read-only within this repository (root: ${root}), plus writing the single config file described above. Don't read, write, or run anything outside this repository — no other git repos/checkouts, no scratch/temp files, no comparing against other projects or past versions of this one, no running the dev stack itself, no installing dependencies. If you can't determine something without stepping outside that scope, make a reasonable assumption and note it (see the ambiguous-case guideline below) rather than going looking for it elsewhere.

Guidelines:
- One services[] entry per process that needs to run (databases, backends, frontends, background workers, one-off setup/build steps).
- Use dependsOn to express startup order (e.g. an API depending on its database).
- Give each long-running service a liveness check (port/http/command) so vibestakr knows when it's actually ready, not just started.
- Use oneShot: true for anything that's expected to exit (a docker run, a migration, a build) rather than run forever.
- Add a dependencies[] entry for any required external tool (docker, a specific runtime version, etc.) that isn't guaranteed to be installed.
- Add a note (e.g. the URL a service serves on) to services people will actually open in a browser.
- If something is genuinely ambiguous (e.g. you can't tell what port a service uses), make a reasonable assumption and leave a comment nearby explaining it — there's no user to ask questions of right now.
- If a .vibestakr.json/.vibestakr/.vibestakr.yaml/.vibestakr.yml already exists, treat this as an update: keep what's still accurate, fix what's wrong, don't blindly overwrite working config.

Full JSON Schema for the config format (also available at schema/run-local.config.schema.json if you install vibestakr as a dependency):

${schema}

A complete, illustrative example (not from this repo — for shape/reference only):

${EXAMPLE_CONFIG}

Project root: ${root}
Write the finished config to ${path.join(root, '.vibestakr.json')} (or .vibestakr/.vibestakr.yaml/.vibestakr.yml if you prefer) when you're done.`
}

const CLI_INVOCATIONS = [
  { name: 'opencode', build: (prompt) => ({ command: 'opencode', args: ['run', prompt] }) },
  { name: 'pi', build: (prompt) => ({ command: 'pi', args: ['-p', prompt] }) },
  { name: 'claude', build: (prompt) => ({ command: 'claude', args: ['-p', prompt] }) },
  { name: 'copilot', build: (prompt) => ({ command: 'copilot', args: ['-p', prompt] }) },
  { name: 'codex', build: (prompt) => ({ command: 'codex', args: ['exec', prompt] }) },
  { name: 'agy', build: (prompt) => ({ command: 'agy', args: ['-p', prompt] }) },
]

const commandExists = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0

function detectCli() {
  return CLI_INVOCATIONS.find((cli) => commandExists(cli.name)) ?? null
}

// Explicit --agent bypasses the on-PATH auto-detect above entirely — trust
// the caller over commandExists() (which can lie in a container/CI shell
// that doesn't source the same PATH this process inherited), and let the
// eventual spawnSync's own res.error surface a genuinely missing binary.
function findCli(name) {
  return CLI_INVOCATIONS.find((cli) => cli.name === name) ?? null
}

// Registers `vibestakr mcp` as a project-scoped MCP server in .mcp.json (the
// format documented in the README, honored by Claude Code and other MCP
// clients that look for a project-local server list). Merges rather than
// overwrites — a user may already have other servers listed here, or have
// customized vibestakr's own entry (extra env, a different invocation) —
// and does nothing if a 'vibestakr' entry already exists, same reasoning.
function ensureMcpConfig(root) {
  const mcpPath = path.join(root, '.mcp.json')
  let existing = {}
  if (fs.existsSync(mcpPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
    } catch (err) {
      console.error(`[vibestakr] ${mcpPath} exists but isn't valid JSON — leaving it as-is (${err.message})`)
      return
    }
  }
  existing.mcpServers = existing.mcpServers || {}
  if (existing.mcpServers.vibestakr) return // already configured — don't clobber a user's own tweaks

  existing.mcpServers.vibestakr = { command: 'npx', args: ['vibestakr', 'mcp'] }
  fs.writeFileSync(mcpPath, `${JSON.stringify(existing, null, 2)}\n`)
  console.error(`[vibestakr] wrote '${mcpPath}' — registers 'vibestakr mcp' as a project-scoped MCP server`)
}

function buildAgentsSection(config) {
  const shortcuts = config.shortcuts || []
  const lines = [
    AGENTS_MD_START,
    '## vibestakr',
    '',
    'This project runs its local dev stack via vibestakr (see .vibestakr.json/.vibestakr.yaml for the full service list):',
    '',
    '- `npx vibestakr` — start (or attach the TUI to) the stack',
    '- `npx vibestakr --background` — start detached, no TUI',
    '- `npx vibestakr stop` — stop everything',
    "- `npx vibestakr mcp` — expose the running stack over MCP (get_status, get_logs, get_services, restart_service, list_shortcuts, run_shortcut) — an agent should prefer this over guessing at ports/logs directly.",
  ]
  if (shortcuts.length) {
    lines.push('', 'Shortcuts (pressable in the TUI, or via the MCP `run_shortcut` tool with the same key):')
    for (const s of shortcuts) lines.push(`- \`${s.key}\` — ${s.label}`)
  }
  lines.push(AGENTS_MD_END)
  return lines.join('\n')
}

// Documents vibestakr's presence + its configured shortcuts in AGENTS.md, so
// an agent reading that file (rather than a human reading README.md) knows
// the stack is already set up and how to drive it, instead of re-discovering
// or re-inventing its own way to start services/read logs. Requires a config
// to already exist (written by the CLI-agent step in main() below, or from a
// previous `vibestakr init` run) — nothing to document otherwise. Re-running
// replaces the previous vibestakr:start/end block in place rather than
// duplicating it, so shortcuts added/renamed later stay in sync.
function ensureAgentsMd(root) {
  let config
  try {
    ;({ config } = loadConfig(root))
  } catch {
    return // no .vibestakr.json/.vibestakr.yaml yet — nothing to document
  }

  const section = buildAgentsSection(config)
  const agentsPath = path.join(root, 'AGENTS.md')
  let content = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : ''
  const startIdx = content.indexOf(AGENTS_MD_START)
  const endIdx = content.indexOf(AGENTS_MD_END)
  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + section + content.slice(endIdx + AGENTS_MD_END.length)
  } else {
    content = content.trimEnd()
    content = (content ? `${content}\n\n` : '') + section + '\n'
  }
  fs.writeFileSync(agentsPath, content)
  console.error(`[vibestakr] updated '${agentsPath}' with vibestakr usage + shortcuts`)
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

// A spinner drawn in-place (carriage-return + no trailing newline) needs a
// real TTY to make sense — a piped/redirected stderr just gets every frame
// as its own line, which is worse than the old plain heartbeat. Only spin
// when stderr is actually a terminal; fall back to periodic plain lines
// otherwise (matches the old AGENT_HEARTBEAT_MS behavior).
function startProgress(label) {
  const start = Date.now()
  const elapsed = () => `${Math.round((Date.now() - start) / 1000)}s`
  if (!process.stderr.isTTY) {
    const id = setInterval(() => console.error(`[vibestakr] ${label} (${elapsed()} elapsed)`), AGENT_HEARTBEAT_MS)
    return () => clearInterval(id)
  }
  let frame = 0
  // Ping-pongs across the same pink-to-orange gradient as LOGO/LOGO_ANSI
  // instead of jumping straight back to pink every SPINNER_FRAMES.length
  // ticks — a period of 2*(N-1) frames goes 0→1→0 with no hard reset.
  const period = 2 * (SPINNER_FRAMES.length - 1)
  const id = setInterval(() => {
    const i = frame++
    const phase = i % period
    const t = phase <= period / 2 ? phase / (period / 2) : (period - phase) / (period / 2)
    const glyph = gradientAnsiAt(SPINNER_FRAMES[i % SPINNER_FRAMES.length], t)
    process.stderr.write(`\r\x1b[K[vibestakr] ${glyph} ${label} (${elapsed()})`)
  }, SPINNER_INTERVAL_MS)
  return () => { clearInterval(id); process.stderr.write('\r\x1b[K') } // \x1b[K erases the spinner line so it doesn't linger under whatever's printed next
}

// Runs the agent CLI async (not spawnSync) so this can show a live spinner/
// progress indicator while it's still working — with output captured rather
// than streamed (see main() below for why), several silent minutes in a row
// is otherwise indistinguishable from a genuine hang. Also enforces
// AGENT_TIMEOUT_MS, since a truly stuck headless agent (rare, but e.g. an
// unexpected permission prompt with nothing on stdin to answer it) would
// otherwise block this command forever.
function runAgent(command, args, { cwd }) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })

    const stopProgress = startProgress(`waiting on '${command}'...`)

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
    }, AGENT_TIMEOUT_MS)

    proc.on('error', (error) => {
      stopProgress()
      clearTimeout(timeout)
      resolve({ error, status: null, stdout, stderr, timedOut })
    })
    proc.on('close', (status) => {
      stopProgress()
      clearTimeout(timeout)
      resolve({ error: null, status, stdout, stderr, timedOut })
    })
  })
}

const OUTPUT_TAIL_LINES = 10

// Full captured stdout/stderr from a failed run can be as noisy as the live
// streaming this file deliberately avoids elsewhere — the last few lines are
// almost always where the actual error is (a stack trace, a permission
// denial, a final summary), so that's what gets shown instead of everything.
function tail(text, n = OUTPUT_TAIL_LINES) {
  const lines = (text || '').split('\n').filter((l) => l.length)
  if (!lines.length) return '(no output)'
  const tailed = lines.slice(-n)
  return tailed.length < lines.length ? `... (${lines.length - tailed.length} earlier lines omitted)\n${tailed.join('\n')}` : tailed.join('\n')
}

// Both stdin and stdout need to be a real terminal for a y/n prompt to make
// sense — piped/redirected stdin has nothing to answer with, piped stdout
// means whatever's consuming this output can't see the question either.
// Non-interactive (e.g. run from a script or CI) keeps the old
// always-proceed/always-write behavior rather than hanging on a question
// nothing can answer.
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function confirm(question, { defaultYes = true } = {}) {
  if (!isInteractive()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`[vibestakr] ${question} [${defaultYes ? 'Y/n' : 'y/N'}] `, (answer) => {
      rl.close()
      const a = answer.trim().toLowerCase()
      resolve(a ? a === 'y' || a === 'yes' : defaultYes)
    })
  })
}

function printAndCopy(prompt) {
  console.log(prompt)
  if (process.platform === 'darwin') {
    const res = spawnSync('pbcopy', [], { input: prompt })
    if (res.status === 0) console.error('\n[vibestakr] no supported coding CLI found on PATH — the prompt above has been copied to your clipboard, paste it into your AI coding tool of choice.')
    else console.error('\n[vibestakr] no supported coding CLI found on PATH — copy the prompt above into your AI coding tool of choice.')
  } else {
    console.error('\n[vibestakr] no supported coding CLI found on PATH — copy the prompt above into your AI coding tool of choice.')
  }
}

async function main(argv = []) {
  console.log(LOGO_ANSI)
  console.log('[vibestakr] init hands off to an AI coding agent already on your machine (claude/codex/opencode/etc) — it inspects this repo (package.json, docker-compose, Dockerfiles, existing dev scripts...) and writes a .vibestakr.json describing your local dev stack for you.\n')
  let parsed
  try {
    parsed = commandLineArgs([{ name: 'agent', alias: 'a', type: String }], { argv })
  } catch (err) {
    console.error(`[vibestakr] ${err.message}`)
    process.exit(1)
  }

  const root = process.cwd()
  const prompt = buildPrompt(root)

  if (!(await confirm(`Generate .vibestakr.json for ${root}?`))) {
    console.error('[vibestakr] aborted — nothing written.')
    process.exit(0)
  }

  let cli
  if (parsed.agent) {
    cli = findCli(parsed.agent)
    if (!cli) {
      console.error(`[vibestakr] unknown --agent '${parsed.agent}' — supported: ${CLI_INVOCATIONS.map((c) => c.name).join(', ')}`)
      process.exit(1)
    }
  } else {
    cli = detectCli()
  }

  if (!cli) {
    printAndCopy(prompt)
    if (await confirm('Add vibestakr usage/shortcuts to AGENTS.md?')) ensureAgentsMd(root) // no-ops unless a config already existed from a previous run — nothing was just generated to document
    if (await confirm('Register vibestakr as an MCP server in .mcp.json?')) ensureMcpConfig(root)
    return
  }

  const { command, args } = cli.build(prompt)
  console.error(`[vibestakr] ${parsed.agent ? `using '${cli.name}' (--agent)` : `found '${cli.name}' on PATH`} — handing off the config-generation prompt to it (this can take a few minutes)...`)
  // Every CLI_INVOCATIONS entry is a confirmed non-interactive/headless
  // invocation (see test/init.test.js) — nothing on stdin ever needs
  // answering, so there's no reason to stream the agent's own live
  // tool-call transcript straight to this terminal (verbose, and on a small
  // scrollback can cut off the actually-useful [vibestakr] lines around it).
  // Captured instead and only dumped on a non-zero exit/timeout, for
  // debugging — runAgent's own heartbeat is what shows this hasn't hung.
  const res = await runAgent(command, args, { cwd: root })
  if (res.error) {
    console.error(`[vibestakr] failed to run '${cli.name}': ${res.error.message}`)
    process.exit(1)
  }
  if (res.timedOut) {
    console.error(`[vibestakr] '${cli.name}' didn't finish within ${AGENT_TIMEOUT_MS / 1000}s — killed it. Last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
    console.error(tail(res.stdout))
    console.error(tail(res.stderr))
    process.exit(1)
  }
  if (res.status !== 0) {
    console.error(`[vibestakr] '${cli.name}' exited with status ${res.status} — last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
    console.error(tail(res.stdout))
    console.error(tail(res.stderr))
    process.exit(res.status ?? 1)
  }
  // Exit 0 only means the CLI itself didn't error — it says nothing about
  // whether it actually wrote a config (e.g. an agent that ran but declined/
  // forgot the file-write step, or lacks write-tool permission in headless
  // mode). Check for real rather than trusting the exit code, since stdout
  // is captured (not streamed) above and would otherwise go unseen entirely.
  const wroteConfig = CANDIDATES.some((f) => fs.existsSync(path.join(root, f)))
  if (!wroteConfig) {
    console.error(`[vibestakr] '${cli.name}' exited 0 but no config (${CANDIDATES.join(', ')}) showed up in ${root} — it may not have finished the task, or lacks permission to write files in headless mode. Last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
    console.error(tail(res.stdout))
    console.error(tail(res.stderr))
    process.exit(1)
  }
  console.error(`[vibestakr] '${cli.name}' finished`)
  // the agent just wrote .vibestakr.json — reflect its shortcuts into AGENTS.md
  if (await confirm('Add vibestakr usage/shortcuts to AGENTS.md?')) ensureAgentsMd(root)
  if (await confirm('Register vibestakr as an MCP server in .mcp.json?')) ensureMcpConfig(root)
  process.exit(0)
}

module.exports = { main, buildPrompt, detectCli, findCli, ensureMcpConfig, ensureAgentsMd, buildAgentsSection, runAgent, tail, confirm, isInteractive, CLI_INVOCATIONS }
