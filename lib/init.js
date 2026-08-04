'use strict'

// `vibestackr init` — agent-assisted config generation. Builds a prompt that
// embeds the JSON Schema + an annotated example and instructs an agent to
// inspect the target repo and produce a valid .vibestackr.yaml, then hands
// that prompt to whichever coding CLI it finds first on PATH. Falls
// back to printing (and pbcopy-ing, on macOS) the prompt if none are found —
// this repo has no way to know every user's installed toolchain, so a manual
// paste-into-your-tool-of-choice path always has to exist.

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { spawn, spawnSync } = require('child_process')
const commandLineArgs = require('command-line-args')
const { loadConfig, findConfigFile, findProjectRoot, CANDIDATES } = require('./config')
const { LOGO_ANSI, gradientAnsiAt } = require('./logo')

const AGENTS_MD_START = '<!-- vibestackr:start -->'
const AGENTS_MD_END = '<!-- vibestackr:end -->'
const AGENT_HEARTBEAT_MS = 15000
const AGENT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_SCHEMA_FIX_ATTEMPTS = 2

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
      "liveness": { "type": "command", "command": "docker exec myapp-postgres pg_isready -U postgres", "timeout": 30 },
      "stopCommand": "docker stop myapp-postgres"
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

function buildPrompt(root, shortcutDescriptions = []) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema', 'config.schema.json'), 'utf8')
  const shortcutsAsk = shortcutDescriptions.length
    ? `\n\nThe user asked for these shortcuts specifically — turn each into a shortcuts[] entry (pick a sensible, unused single-character key for each; use "restart": "<service>" for a restart-type shortcut, or "command": "<shell command>" for anything else; if a description needs a value the user would type at the time (an environment name, a migration version, etc.) rather than something fixed in advance, add an inputs[] entry for it and reference it in command as \${name}):\n${shortcutDescriptions.map((d) => `- ${d}`).join('\n')}`
    : ''
  return `You're setting up vibestackr for this repository. vibestackr is a TUI that brings up a local dev stack (multiple services, in dependency order, with liveness checks) from a single config file: .vibestackr.yaml (or .vibestackr/.vibestackr.yml/.vibestackr.json/.vibestackr) in the project root.${shortcutsAsk}

Your job: inspect this repository (package.json scripts, docker-compose files, existing dev/README scripts, Dockerfiles, .env.example, etc.) and write a valid .vibestackr.yaml at the project root describing how to run its full local dev stack.

Scope: read-only within this repository (root: ${root}), plus writing the single config file described above. Don't read, write, or run anything outside this repository — no other git repos/checkouts, no scratch/temp files, no comparing against other projects or past versions of this one, no running the dev stack itself, no installing dependencies. If you can't determine something without stepping outside that scope, make a reasonable assumption and note it (see the ambiguous-case guideline below) rather than going looking for it elsewhere.

Guidelines:
- One services[] entry per process that needs to run (databases, backends, frontends, background workers, one-off setup/build steps).
- Use dependsOn to express startup order (e.g. an API depending on its database).
- Give each long-running service a liveness check (port/http/command) so vibestackr knows when it's actually ready, not just started.
- Use oneShot: true for anything that's expected to exit (a docker run, a migration, a build) rather than run forever.
- For a oneShot service whose process exits but leaves something else running behind it (a 'docker run -d'/'docker compose up -d' container, a backgrounded daemon, etc.), add a stopCommand (e.g. 'docker stop <container>' or 'docker compose down') so vibestackr actually stops it on shutdown/restart instead of leaving it running forever.
- Add a dependencies[] entry for any required external tool (docker, a specific runtime version, etc.) that isn't guaranteed to be installed.
- Add a note (e.g. the URL a service serves on) to services people will actually open in a browser.
- If something is genuinely ambiguous (e.g. you can't tell what port a service uses), make a reasonable assumption and leave a comment nearby explaining it — there's no user to ask questions of right now.
- If a .vibestackr.yaml/.vibestackr.yml/.vibestackr.json/.vibestackr already exists, treat this as an update: keep what's still accurate, fix what's wrong, don't blindly overwrite working config.

Full JSON Schema for the config format (also available at schema/config.schema.json if you install vibestackr as a dependency):

${schema}

A complete, illustrative example (not from this repo — for shape/reference only):

${EXAMPLE_CONFIG}

Project root: ${root}
Write the finished config to ${path.join(root, '.vibestackr.yaml')} (or .vibestackr/.vibestackr.yml/.vibestackr.json/.vibestackr if you prefer) when you're done.`
}

function buildUpdatePrompt(root, description) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema', 'config.schema.json'), 'utf8')
  return `You're updating an EXISTING vibestackr config for this repository — a .vibestackr.yaml/.vibestackr.yml/.vibestackr.json/.vibestackr file at its root already describes its local dev stack.

Your job: apply the requested change below to that existing file, editing it in place. Keep everything else in the file exactly as it is unless the requested change genuinely requires touching it — this is an edit, not a rewrite.

Requested change:
${description}

Scope: read-only within this repository (root: ${root}), plus editing that single existing config file. Don't read, write, or run anything outside this repository — no other git repos/checkouts, no running the dev stack itself, no installing dependencies.

Full JSON Schema for the config format (also available at schema/config.schema.json if you install vibestackr as a dependency):

${schema}

Project root: ${root}`
}

// Fed back to the same agent after it writes a config that doesn't validate
// against the schema — gives it the exact Ajv error rather than making it
// re-derive what's wrong from scratch, and points at the specific file it
// already wrote so it edits in place instead of starting over.
function buildSchemaFixPrompt(root, file, errorMessage) {
  return `The .vibestackr config you just wrote at ${file} (project root: ${root}) fails schema validation:

${errorMessage}

Fix the file in place so it validates against the schema. Same scope as before: read-only within this repository plus editing that one config file.`
}

// Validates whatever config now exists on disk and returns null on success,
// or the formatted error message loadConfig() throws (schema mismatch,
// unparseable YAML/JSON, etc) — used to decide whether to loop the agent
// back in with buildSchemaFixPrompt() rather than trusting a 0 exit code +
// file-exists check alone.
function validateWrittenConfig(root) {
  try {
    loadConfig(root)
    return null
  } catch (err) {
    return err.message
  }
}

// Headless/non-interactive invocations of these CLIs default to asking for
// tool-use permission (file writes included) — with no TTY to answer that
// prompt, the write is just silently denied and the process still exits 0,
// looking indistinguishable from success until the missing-config check
// below catches it. Each entry here therefore also passes whatever flag
// that specific CLI needs to auto-approve tool calls headlessly.
const CLI_INVOCATIONS = [
  { name: 'opencode', build: (prompt) => ({ command: 'opencode', args: ['run', '--auto', prompt] }) },
  { name: 'pi', build: (prompt) => ({ command: 'pi', args: ['-p', prompt] }) },
  { name: 'claude', build: (prompt) => ({ command: 'claude', args: ['-p', '--permission-mode', 'acceptEdits', prompt] }) },
  { name: 'copilot', build: (prompt) => ({ command: 'copilot', args: ['--allow-all-tools', '-p', prompt] }) },
  { name: 'codex', build: (prompt) => ({ command: 'codex', args: ['exec', prompt] }) },
  { name: 'agy', build: (prompt) => ({ command: 'agy', args: ['--dangerously-skip-permissions', '-p', prompt] }) },
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

// Registers `vibestackr mcp` as a project-scoped MCP server in .mcp.json (the
// format documented in the README, honored by Claude Code and other MCP
// clients that look for a project-local server list). Merges rather than
// Registers `vibestackr mcp` as a project-scoped MCP server in project MCP
// config files (.mcp.json for Claude Code/Cursor/generic, .agents/mcp_config.json
// for Antigravity, and .opencode/opencode.json or opencode.json for OpenCode).
// Merges rather than overwrites — a user may already have other servers listed
// here, or have customized vibestackr's own entry (extra env, a different
// invocation) — and does nothing if a 'vibestackr' entry already exists, same reasoning.
function ensureMcpConfig(root) {
  const written = []
  const standardConfigs = [
    path.join(root, '.mcp.json'),
    path.join(root, '.agents', 'mcp_config.json'),
  ]

  if (fs.existsSync(path.join(root, '.roo')) || fs.existsSync(path.join(root, '.roo', 'mcp.json'))) {
    standardConfigs.push(path.join(root, '.roo', 'mcp.json'))
  }
  if (fs.existsSync(path.join(root, '.cursor')) || fs.existsSync(path.join(root, '.cursor', 'mcp.json'))) {
    standardConfigs.push(path.join(root, '.cursor', 'mcp.json'))
  }

  for (const configPath of standardConfigs) {
    let existing = {}
    if (fs.existsSync(configPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      } catch (err) {
        console.error(`[vibestackr] ${configPath} exists but isn't valid JSON — leaving it as-is (${err.message})`)
        continue
      }
    }
    existing.mcpServers = existing.mcpServers || {}
    if (existing.mcpServers.vibestackr) continue

    existing.mcpServers.vibestackr = { command: 'npx', args: ['vibestackr', 'mcp'] }
    const dir = path.dirname(configPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`)
    console.error(`[vibestackr] wrote '${configPath}' — registers 'vibestackr mcp' as a project-scoped MCP server`)
    written.push(configPath)
  }

  const opencodeRootPath = path.join(root, 'opencode.json')
  const opencodeDotPath = path.join(root, '.opencode', 'opencode.json')
  let openCodePath = null

  if (fs.existsSync(opencodeRootPath)) {
    openCodePath = opencodeRootPath
  } else if (fs.existsSync(opencodeDotPath)) {
    openCodePath = opencodeDotPath
  } else if (fs.existsSync(path.join(root, '.opencode')) || commandExists('opencode')) {
    openCodePath = opencodeDotPath
  }

  if (openCodePath) {
    let existing = {}
    if (fs.existsSync(openCodePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(openCodePath, 'utf8'))
      } catch (err) {
        console.error(`[vibestackr] ${openCodePath} exists but isn't valid JSON — leaving it as-is (${err.message})`)
        return written
      }
    }
    existing.mcp = existing.mcp || {}
    if (!existing.mcp.vibestackr) {
      existing.mcp.vibestackr = {
        type: 'local',
        command: ['npx', 'vibestackr', 'mcp'],
        enabled: true,
      }
      const dir = path.dirname(openCodePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(openCodePath, `${JSON.stringify(existing, null, 2)}\n`)
      console.error(`[vibestackr] wrote '${openCodePath}' — registers 'vibestackr mcp' as an OpenCode MCP server`)
      written.push(openCodePath)
    }
  }

  return written
}

function buildAgentsSection(config) {
  const shortcuts = config.shortcuts || []
  const lines = [
    AGENTS_MD_START,
    '## vibestackr',
    '',
    'This project runs its local dev stack via vibestackr (see .vibestackr.yaml/.vibestackr.json for the full service list):',
    '',
    '- `npx vibestackr` — start (or attach the TUI to) the stack',
    '- `npx vibestackr --background` — start detached, no TUI',
    '- `npx vibestackr stop` — stop everything',
    "- `npx vibestackr mcp` — expose the running stack over MCP (get_status, get_logs, get_services, restart_service, list_shortcuts, run_shortcut) — an agent should prefer this over guessing at ports/logs directly.",
  ]
  if (shortcuts.length) {
    lines.push('', 'Shortcuts (pressable in the TUI, or via the MCP `run_shortcut` tool with the same key):')
    for (const s of shortcuts) lines.push(`- \`${s.key}\` — ${s.label}`)
  }
  lines.push(AGENTS_MD_END)
  return lines.join('\n')
}

// Documents vibestackr's presence + its configured shortcuts in AGENTS.md
// (and CLAUDE.md if it exists), so an agent reading instruction files knows
// how to drive the stack.
function ensureAgentsMd(root) {
  let config
  try {
    ;({ config } = loadConfig(root))
  } catch {
    return [] // no .vibestackr.yaml/.vibestackr.json yet — nothing to document
  }

  const written = []
  const section = buildAgentsSection(config)
  const targetFiles = ['AGENTS.md']
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) targetFiles.push('CLAUDE.md')

  for (const file of targetFiles) {
    const agentsPath = path.join(root, file)
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
    console.error(`[vibestackr] updated '${agentsPath}' with vibestackr usage + shortcuts`)
    written.push(agentsPath)
  }
  return written
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
    const id = setInterval(() => console.error(`[vibestackr] ${label} (${elapsed()} elapsed)`), AGENT_HEARTBEAT_MS)
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
    process.stderr.write(`\r\x1b[K[vibestackr] ${glyph} ${label} (${elapsed()})`)
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
    rl.question(`[vibestackr] ${question} [${defaultYes ? 'Y/n' : 'y/N'}] `, (answer) => {
      rl.close()
      const a = answer.trim().toLowerCase()
      resolve(a ? a === 'y' || a === 'yes' : defaultYes)
    })
  })
}

// Repeatedly prompts for one shortcut description per line until the user
// submits a blank line — each raw description (e.g. "r restarts the api
// service", "p rebuilds the plugin jar") is handed to the agent CLI as-is in
// buildPrompt() to translate into a schema-valid shortcuts[] entry, since
// there's no user to ask "restart or command-type?" once the agent is
// running headless.
function collectShortcutDescriptions() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const descriptions = []
    const askNext = () => {
      rl.question(`[vibestackr] Shortcut ${descriptions.length + 1} (key + what it should do), or Enter to finish: `, (answer) => {
        const trimmed = answer.trim()
        if (!trimmed) { rl.close(); resolve(descriptions); return }
        descriptions.push(trimmed)
        askNext()
      })
    }
    askNext()
  })
}

function printAndCopy(prompt) {
  console.log(prompt)
  if (process.platform === 'darwin') {
    const res = spawnSync('pbcopy', [], { input: prompt })
    if (res.status === 0) console.error('\n[vibestackr] no supported coding CLI found on PATH — the prompt above has been copied to your clipboard, paste it into your AI coding tool of choice.')
    else console.error('\n[vibestackr] no supported coding CLI found on PATH — copy the prompt above into your AI coding tool of choice.')
  } else {
    console.error('\n[vibestackr] no supported coding CLI found on PATH — copy the prompt above into your AI coding tool of choice.')
  }
}

async function main(argv = []) {
  console.log(LOGO_ANSI)
  let parsed
  try {
    parsed = commandLineArgs([
      { name: 'agent', alias: 'a', type: String },
      { name: 'mcp', type: Boolean },
      { name: 'agents', type: Boolean },
    ], { argv })
  } catch (err) {
    console.error(`[vibestackr] ${err.message}`)
    process.exit(1)
  }

  const root = process.cwd()

  if (parsed.mcp || parsed.agents) {
    if (parsed.mcp) {
      const written = ensureMcpConfig(root)
      if (!written.length) {
        console.error('[vibestackr] MCP server configuration is already up to date across project config files.')
      }
    }
    if (parsed.agents) {
      const written = ensureAgentsMd(root)
      if (!written.length) {
        if (!CANDIDATES.some((f) => fs.existsSync(path.join(root, f)))) {
          console.error(`[vibestackr] no config (${CANDIDATES.join(', ')}) found in ${root} — run 'vibestackr init' first to generate one.`)
          process.exit(1)
        }
      }
    }
    process.exit(0)
  }

  console.log('[vibestackr] init hands off to an AI coding agent already on your machine (claude/codex/opencode/etc) — it inspects this repo (package.json, docker-compose, Dockerfiles, existing dev scripts...) and writes a .vibestackr.yaml describing your local dev stack for you.\n')

  if (!(await confirm(`Generate .vibestackr.yaml for ${root}?`))) {
    console.error('[vibestackr] aborted — nothing written.')
    process.exit(0)
  }

  let shortcutDescriptions = []
  if (await confirm('Would you like to describe any keyboard shortcuts you\'d like configured?', { defaultYes: false })) {
    shortcutDescriptions = await collectShortcutDescriptions()
  }

  const prompt = buildPrompt(root, shortcutDescriptions)

  let cli
  if (parsed.agent) {
    cli = findCli(parsed.agent)
    if (!cli) {
      console.error(`[vibestackr] unknown --agent '${parsed.agent}' — supported: ${CLI_INVOCATIONS.map((c) => c.name).join(', ')}`)
      process.exit(1)
    }
  } else {
    cli = detectCli()
  }

  if (!cli) {
    printAndCopy(prompt)
    if (await confirm('Add vibestackr usage/shortcuts to AGENTS.md?')) ensureAgentsMd(root) // no-ops unless a config already existed from a previous run — nothing was just generated to document
    if (await confirm('Register vibestackr as an MCP server in project config files (.mcp.json, .agents/mcp_config.json, etc.)?')) ensureMcpConfig(root)
    // Same reasoning as ensureAgentsMd above: only offer this if a config
    // actually exists (e.g. left over from a previous run) — nothing was
    // just generated in THIS run since no CLI was found to hand the prompt to.
    if (CANDIDATES.some((f) => fs.existsSync(path.join(root, f))) && (await confirm('Start the stack now?'))) {
      process.exit(await runStack(root))
    }
    return
  }

  const { command, args } = cli.build(prompt)
  console.error(`[vibestackr] ${parsed.agent ? `using '${cli.name}' (--agent)` : `found '${cli.name}' on PATH`} — handing off the config-generation prompt to it (this can take a few minutes)...`)
  // Every CLI_INVOCATIONS entry is a confirmed non-interactive/headless
  // invocation (see test/init.test.js) — nothing on stdin ever needs
  // answering, so there's no reason to stream the agent's own live
  // tool-call transcript straight to this terminal (verbose, and on a small
  // scrollback can cut off the actually-useful [vibestackr] lines around it).
  // Captured instead and only dumped on a non-zero exit/timeout, for
  // debugging — runAgent's own heartbeat is what shows this hasn't hung.
  const res = await runAgent(command, args, { cwd: root })
  if (res.error) {
    console.error(`[vibestackr] failed to run '${cli.name}': ${res.error.message}`)
    process.exit(1)
  }
  if (res.timedOut) {
    console.error(`[vibestackr] '${cli.name}' didn't finish within ${AGENT_TIMEOUT_MS / 1000}s — killed it. Last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
    console.error(tail(res.stdout))
    console.error(tail(res.stderr))
    process.exit(1)
  }
  if (res.status !== 0) {
    console.error(`[vibestackr] '${cli.name}' exited with status ${res.status} — last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
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
    console.error(`[vibestackr] '${cli.name}' exited 0 but no config (${CANDIDATES.join(', ')}) showed up in ${root} — it may not have finished the task, or lacks permission to write files in headless mode. Last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
    console.error(tail(res.stdout))
    console.error(tail(res.stderr))
    process.exit(1)
  }
  console.error(`[vibestackr] '${cli.name}' finished`)

  // The agent's exit code + a file existing say nothing about whether that
  // file actually validates — loop it back in with the exact Ajv error
  // (rather than failing outright) up to MAX_SCHEMA_FIX_ATTEMPTS times, since
  // agents reliably self-correct given the concrete error to fix.
  let validationError = validateWrittenConfig(root)
  for (let attempt = 1; validationError && attempt <= MAX_SCHEMA_FIX_ATTEMPTS; attempt++) {
    console.error(`[vibestackr] written config fails schema validation (attempt ${attempt}/${MAX_SCHEMA_FIX_ATTEMPTS}) — asking '${cli.name}' to fix it:\n${validationError}`)
    const file = findConfigFile(root)
    const fixPrompt = buildSchemaFixPrompt(root, file, validationError)
    const fixCli = cli.build(fixPrompt)
    const fixRes = await runAgent(fixCli.command, fixCli.args, { cwd: root })
    if (fixRes.error || fixRes.timedOut || fixRes.status !== 0) {
      console.error(`[vibestackr] schema-fix attempt failed to run '${cli.name}' cleanly — last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
      console.error(tail(fixRes.stdout))
      console.error(tail(fixRes.stderr))
      break
    }
    validationError = validateWrittenConfig(root)
  }
  if (validationError) {
    console.error(`[vibestackr] config still fails schema validation after ${MAX_SCHEMA_FIX_ATTEMPTS} fix attempt(s):\n${validationError}\nFix it by hand, or re-run 'vibestackr config "<description>"' to try again.`)
    process.exit(1)
  }

  // the agent just wrote .vibestackr.yaml — reflect its shortcuts into AGENTS.md
  if (await confirm('Add vibestackr usage/shortcuts to AGENTS.md?')) ensureAgentsMd(root)
  if (await confirm('Register vibestackr as an MCP server in project config files (.mcp.json, .agents/mcp_config.json, etc.)?')) ensureMcpConfig(root)
  if (await confirm('Start the stack now?')) {
    process.exit(await runStack(root))
  }
  process.exit(0)
}

// Hands off to the real `vibestackr` (bin/vibestackr, not this file) with
// stdio inherited, so init's job ends here and the TUI takes over the
// terminal exactly as if the user had typed `vibestackr` themselves —
// resolves once that process exits (TUI detach/'b', 'q', Ctrl+C, etc), with
// its own exit code passed straight through.
function runStack(root) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'vibestackr')], { cwd: root, stdio: 'inherit' })
    proc.on('exit', (code) => resolve(code ?? 0))
  })
}

// `vibestackr config <description>` — same agent-handoff mechanics as init,
// but for editing an ALREADY-existing config rather than generating one from
// scratch: no repo re-inspection framing, no example config, no shortcuts
// walkthrough (the description itself can ask for shortcut changes) — just
// "here's the existing schema, here's what the user wants changed".
async function configMain(argv = []) {
  console.log(LOGO_ANSI)
  let parsed
  try {
    parsed = commandLineArgs([{ name: 'agent', alias: 'a', type: String }, { name: 'description', type: String, multiple: true, defaultOption: true }], { argv })
  } catch (err) {
    console.error(`[vibestackr] ${err.message}`)
    process.exit(1)
  }

  // Walks upward from cwd, so `vibestackr config` (unlike `vibestackr init`,
  // which always targets cwd itself — there's nothing existing to find yet)
  // works the same from any subdirectory of the project, not just its root.
  const root = findProjectRoot(process.cwd())
  if (!CANDIDATES.some((f) => fs.existsSync(path.join(root, f)))) {
    console.error(`[vibestackr] no config (${CANDIDATES.join(', ')}) found in ${root} or any parent directory — run 'vibestackr init' first.`)
    process.exit(1)
  }

  let description = (parsed.description || []).join(' ').trim()
  if (!description) {
    if (!isInteractive()) {
      console.error('[vibestackr] no description given — pass one as an argument, e.g. `vibestackr config "add a redis service"`.')
      process.exit(1)
    }
    description = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question('[vibestackr] What would you like to change about your config? ', (answer) => { rl.close(); resolve(answer.trim()) })
    })
    if (!description) {
      console.error('[vibestackr] aborted — nothing changed.')
      process.exit(0)
    }
  }

  if (!(await confirm(`Update the config in ${root} with: "${description}"?`))) {
    console.error('[vibestackr] aborted — nothing changed.')
    process.exit(0)
  }

  const prompt = buildUpdatePrompt(root, description)

  let cli
  if (parsed.agent) {
    cli = findCli(parsed.agent)
    if (!cli) {
      console.error(`[vibestackr] unknown --agent '${parsed.agent}' — supported: ${CLI_INVOCATIONS.map((c) => c.name).join(', ')}`)
      process.exit(1)
    }
  } else {
    cli = detectCli()
  }

  if (!cli) {
    printAndCopy(prompt)
    return
  }

  const { command, args } = cli.build(prompt)
  console.error(`[vibestackr] ${parsed.agent ? `using '${cli.name}' (--agent)` : `found '${cli.name}' on PATH`} — handing off the config-update prompt to it (this can take a few minutes)...`)
  const res = await runAgent(command, args, { cwd: root })
  if (res.error) {
    console.error(`[vibestackr] failed to run '${cli.name}': ${res.error.message}`)
    process.exit(1)
  }
  if (res.timedOut) {
    console.error(`[vibestackr] '${cli.name}' didn't finish within ${AGENT_TIMEOUT_MS / 1000}s — killed it. Last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
    console.error(tail(res.stdout))
    console.error(tail(res.stderr))
    process.exit(1)
  }
  if (res.status !== 0) {
    console.error(`[vibestackr] '${cli.name}' exited with status ${res.status} — last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
    console.error(tail(res.stdout))
    console.error(tail(res.stderr))
    process.exit(res.status ?? 1)
  }
  console.error(`[vibestackr] '${cli.name}' finished`)

  let validationError = validateWrittenConfig(root)
  for (let attempt = 1; validationError && attempt <= MAX_SCHEMA_FIX_ATTEMPTS; attempt++) {
    console.error(`[vibestackr] updated config fails schema validation (attempt ${attempt}/${MAX_SCHEMA_FIX_ATTEMPTS}) — asking '${cli.name}' to fix it:\n${validationError}`)
    const file = findConfigFile(root)
    const fixPrompt = buildSchemaFixPrompt(root, file, validationError)
    const fixCli = cli.build(fixPrompt)
    const fixRes = await runAgent(fixCli.command, fixCli.args, { cwd: root })
    if (fixRes.error || fixRes.timedOut || fixRes.status !== 0) {
      console.error(`[vibestackr] schema-fix attempt failed to run '${cli.name}' cleanly — last ${OUTPUT_TAIL_LINES} lines of stdout/stderr:`)
      console.error(tail(fixRes.stdout))
      console.error(tail(fixRes.stderr))
      break
    }
    validationError = validateWrittenConfig(root)
  }
  if (validationError) {
    console.error(`[vibestackr] config still fails schema validation after ${MAX_SCHEMA_FIX_ATTEMPTS} fix attempt(s):\n${validationError}\nFix it by hand, or re-run 'vibestackr config "<description>"' to try again.`)
    process.exit(1)
  }

  // the update may have touched shortcuts — keep AGENTS.md in sync same as init does
  if (await confirm('Update vibestackr usage/shortcuts in AGENTS.md?')) ensureAgentsMd(root)
  process.exit(0)
}

module.exports = { main, configMain, buildPrompt, buildUpdatePrompt, buildSchemaFixPrompt, validateWrittenConfig, detectCli, findCli, ensureMcpConfig, ensureAgentsMd, buildAgentsSection, runAgent, tail, confirm, isInteractive, collectShortcutDescriptions, CLI_INVOCATIONS }
