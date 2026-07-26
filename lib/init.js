'use strict'

// `vibestakr init` — agent-assisted config generation. Builds a prompt that
// embeds the JSON Schema + an annotated example and instructs an agent to
// inspect the target repo and produce a valid run-local.config.json, then
// hands that prompt to whichever coding CLI it finds first on PATH. Falls
// back to printing (and pbcopy-ing, on macOS) the prompt if none are found —
// this repo has no way to know every user's installed toolchain, so a manual
// paste-into-your-tool-of-choice path always has to exist.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

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
  return `You're setting up vibestakr for this repository. vibestakr is a TUI that brings up a local dev stack (multiple services, in dependency order, with liveness checks) from a single config file: run-local.config.json (or .yaml/.yml) in the project root.

Your job: inspect this repository (package.json scripts, docker-compose files, existing dev/README scripts, Dockerfiles, .env.example, etc.) and write a valid run-local.config.json at the project root describing how to run its full local dev stack.

Guidelines:
- One services[] entry per process that needs to run (databases, backends, frontends, background workers, one-off setup/build steps).
- Use dependsOn to express startup order (e.g. an API depending on its database).
- Give each long-running service a liveness check (port/http/command) so vibestakr knows when it's actually ready, not just started.
- Use oneShot: true for anything that's expected to exit (a docker run, a migration, a build) rather than run forever.
- Add a dependencies[] entry for any required external tool (docker, a specific runtime version, etc.) that isn't guaranteed to be installed.
- Add a note (e.g. the URL a service serves on) to services people will actually open in a browser.
- If something is genuinely ambiguous (e.g. you can't tell what port a service uses), make a reasonable assumption and leave a comment nearby explaining it — there's no user to ask questions of right now.
- If a run-local.config.json/.yaml/.yml already exists, treat this as an update: keep what's still accurate, fix what's wrong, don't blindly overwrite working config.

Full JSON Schema for the config format (also available at schema/run-local.config.schema.json if you install vibestakr as a dependency):

${schema}

A complete, illustrative example (not from this repo — for shape/reference only):

${EXAMPLE_CONFIG}

Project root: ${root}
Write the finished config to ${path.join(root, 'run-local.config.json')} (or .yaml/.yml if you prefer) when you're done.`
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

function main() {
  const root = process.cwd()
  const prompt = buildPrompt(root)
  const cli = detectCli()

  if (!cli) {
    printAndCopy(prompt)
    return
  }

  const { command, args } = cli.build(prompt)
  console.error(`[vibestakr] found '${cli.name}' on PATH — handing off the config-generation prompt to it...`)
  const res = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (res.error) {
    console.error(`[vibestakr] failed to run '${cli.name}': ${res.error.message}`)
    process.exit(1)
  }
  process.exit(res.status ?? 0)
}

module.exports = { main, buildPrompt, detectCli, CLI_INVOCATIONS }
