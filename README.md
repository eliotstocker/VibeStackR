# vibestackr

[![npm version](https://img.shields.io/npm/v/vibestackr.svg)](https://www.npmjs.com/package/vibestackr)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-%40eliotstocker%2Fvibestackr-blue?logo=github)](https://github.com/eliotstocker/VibeStackR/pkgs/npm/vibestackr)

A portable TUI that brings up your entire local dev stack with one command —
services, dependency order, liveness checks, and keyboard shortcuts, all
driven by a single config file you drop into your project.

Built for you AND your AI coding agent equally, not just as a human-facing
TUI with an API bolted on. `vibestackr init` hands an agent the job of writing
your config in the first place; `vibestackr mcp` lets one read status/logs,
restart a service, or trigger a shortcut mid-session without leaving its own
context; `reload_config` lets it apply a config edit without restarting your
stack; and `init` documents all of that for it in your project's own
`AGENTS.md`, so it already knows the stack is there and how to drive it.

```
┌─ vibestackr ─────────────────────────────────────────────────────────────┐
│ [run-local] all required dependencies present                          │
│ [run-local] starting postgres (docker run, port 5432)                  │
│ [run-local] ✓ postgres ready                                            │
│ [run-local] starting api (http://localhost:4000)                       │
│ [run-local] ✓ api ready                                                 │
│ [run-local] starting web (http://localhost:5173)                       │
│ [run-local] all apps started — Ctrl+C to stop (or 'q'; 'r' restart api) │
└──────────────────────────────────────────────────────────────────────────┘
 VibeStackR | 2 up  1 pending  0 down | q quit  b background  R reload config  O show more  Tab/←→ switch  ↑↓ scroll  r restart api
```

## Simple Demo

![demo](docs/demo.svg)

*`npx vibestackr` starting from scratch in a multi service repo root, agent wait time is cut out of the recording.*

## Install & run

No install step needed — just run it in a project that has a
`.vibestackr.yaml` (see below):

```sh
npx vibestackr
```

Or add it as a `devDependency` and wire up a script:

```sh
npm install --save-dev vibestackr
```

```json
{ "scripts": { "dev": "vibestackr" } }
```

## Quick start

Don't have a config yet? Let an AI coding agent write one for you by
inspecting your repo:

```sh
npx vibestackr init
```

This detects a coding CLI on your `PATH` (`opencode`, `pi`, `claude`,
`copilot`, `codex`, or `agy`, in that order — or pick one explicitly with
`--agent <name>`) and hands it a prompt describing the config format, or
prints (and on macOS, copies) the prompt for you to paste into whatever AI
tool you use, if none of those are installed. It'll ask for confirmation
before running (and again before each of the steps below) if you're at an
interactive terminal.

`init` also, once a config exists:
- registers `vibestackr mcp` as a project-scoped MCP server in `.mcp.json`
- writes a section into your project's `AGENTS.md` documenting that
  vibestackr's set up, its CLI commands, and its configured shortcuts — so an
  agent working in this repo later already knows, without being told

Already have a config and just want to change something about it? `vibestackr
config` hands the same agent a targeted edit instead of a from-scratch rewrite:

```sh
npx vibestackr config "add a redis service on port 6379"
```

Give the description as an argument, or leave it off to be asked for one
interactively. Same `--agent <name>` override and CLI auto-detection/fallback
as `init`.

Or write `.vibestackr.yaml` by hand — a minimal example:

```yaml
name: MyApp
services:
  - name: postgres
    cwd: .
    command: sh
    args: ["-c", "docker start myapp-postgres 2>/dev/null || docker run -d --name myapp-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:16"]
    oneShot: true
    liveness: { type: command, command: docker exec myapp-postgres pg_isready -U postgres }
  - name: api
    cwd: api
    command: npm
    args: ["run", "dev"]
    note: http://localhost:4000
    dependsOn: ["postgres"]
    liveness: { type: http, url: http://localhost:4000/health }
```

Then just:

```sh
npx vibestackr
```

## Config reference

`.vibestackr.yaml` (or `.vibestackr.yml`, `.vibestackr.json`, or `.vibestackr`
with no extension — same shape either way) lives in your project root. Pass
`--config <path>` instead to point at a differently-named or -located file.
The full format is described by
[`schema/config.schema.json`](schema/config.schema.json)
— point your editor at it for autocomplete:

```json
{ "$schema": "node_modules/vibestackr/schema/config.schema.json" }
```

Top-level fields:

| Field | Description |
| --- | --- |
| `name` | Shown in the TUI's corner and terminal title. Defaults to `run-local`. |
| `services[]` | One entry per process vibestackr manages. |
| `dependencies[]` | Checks run before startup; abort with a clear message if `when` conditions are all true. |
| `warnings[]` | Non-fatal messages printed at startup, same `when` conditions. |
| `shortcuts[]` | Single-key actions available while the TUI is running. |

### `services[]`

| Field | Description |
| --- | --- |
| `name` (required) | Unique identifier — tab name, and used in `--exclude`/`--only`/`dependsOn`/`restart`. |
| `command` (required) | Executable to spawn, e.g. `npm`, `sh`, `./gradlew`. |
| `type` | Free-form label. `"node"` additionally triggers an automatic `npm install` on first run if `cwd/node_modules` is missing. |
| `cwd` | Working directory, relative to the project root. |
| `args` | Array of command-line arguments. |
| `env` | Extra environment variables merged over `process.env`, for this service only. |
| `note` | One-line description pinned atop the service's tab (e.g. its URL) and in its startup log line. |
| `oneShot` | `true` for a job that's expected to exit (a build, a migration, a `docker run`) rather than run forever. |
| `watcher` | `true` if this service auto-restarts/reloads itself on file changes (nodemon, vite/webpack HMR, spring-boot devtools, etc). Purely informational — vibestackr doesn't implement the watching itself, just surfaces the fact (e.g. via the `get_services` MCP tool). |
| `dependsOn[]` | Other service names that must be ready before this one starts. |
| `liveness` | How vibestackr decides the service is ready — see below. |
| `onSuccess` | Shell command run once a `oneShot` service's process exits with code 0. Fires on exit, not on liveness. |
| `onReady` | Shell command run once the service is actually ready (liveness passed, or exited if `oneShot` with no liveness). Skipped on a liveness timeout/failure. |
| `jsonLog` | Reformats structured (NDJSON) output for display — see below. |

**Liveness** (`services[].liveness`) — one of:

```json
{ "type": "port", "host": "localhost", "port": 5173, "timeout": 300 }
{ "type": "http", "url": "http://localhost:4000/health", "timeout": 300 }
{ "type": "command", "command": "docker exec my-db pg_isready -U postgres", "timeout": 30 }
```

`timeout` is in seconds (default 300); a service that never becomes ready is
marked `timeout`, not stuck forever.

### `dependencies[]` / `warnings[]`

Both share the same `when[]` condition list — a check fires (dependency:
aborts startup; warning: prints a message) when **every** condition in
`when` evaluates true (omitted/empty `when` always fires):

```json
{
  "message": "docker (install: brew install --cask docker)",
  "when": [{ "commandMissing": "docker" }]
}
```

Condition types: `envSet`/`envUnset` (a var), `envNotIn` (`{var, values}`),
`commandExists`/`commandMissing`, `commandFails` (`{command, args}`, exit
code ≠ 0), `included`/`excluded` (a service name), `anyIncluded` (array of
service names). `message` (and `commandFails.command`/`args`) support
`${VAR}` / `${VAR:-default}` interpolation from `process.env`.

`warnings[]` entries can also set `service`, which prefixes the message with
`<service>: ` and skips it entirely if that service is excluded from the run.

### `shortcuts[]`

```json
{ "key": "r", "label": "restart api", "restart": "api" }
{ "key": "g", "label": "regenerate clients", "command": "npm run generate:api", "cwd": "api" }
```

`restart` (name of a service to restart, or start if not running) and
`command` (a literal shell command, run with `cwd` relative to the project
root) are mutually exclusive.

### `jsonLog` — pretty-printing structured logs

If a service outputs one JSON object per line (Spring Boot's logback JSON
encoder, pino, winston, etc.), reformat it for display:

```json
{
  "jsonLog": {
    "format": "${@timestamp} [${level}] ${message}",
    "levelField": "level",
    "colors": { "notice": "cyan" }
  }
}
```

- `format` (required) — template built from the parsed JSON fields.
  `${field}` supports dot-path for nested fields (`${context.requestId}`),
  `@`-prefixed ECS-style fields (`${@timestamp}`), and `${field:-default}`.
- `levelField` — which field holds the log level, used to color the whole
  line (case-insensitive: `error`/`fatal`/`severe` → red, `warn`/`warning` →
  yellow, `debug`/`trace` → grey, anything else uncolored). Defaults to
  `"level"`.
- `colors` — overrides/extends the default level→color mapping.

Only lines that actually parse as a single JSON object are reformatted —
everything else (build tool banners, stack traces) is shown unchanged. This
is purely a display transform: the ring buffer, `--persist-logs` file, and
`vibestackr mcp`'s `get_logs` tool all still see the original raw line.

## CLI flags

```
npx vibestackr [--config <path>] [--background] [--exclude <name>[,<name>...]] [--only <name>[,<name>...]] [--persist-logs] [--service-log]
```

| Flag | Description |
| --- | --- |
| `-c, --config <path>` | Path to the config file (relative to the project root, or absolute). Skips auto-discovery of `.vibestackr.yaml`/`.vibestackr.yml`/`.vibestackr.json`/`.vibestackr`. |
| `-b, --background` | Start the stack and exit immediately, without opening a TUI. Run `npx vibestackr` any time afterward to attach one, or `npx vibestackr stop` to shut it down. |
| `-e, --exclude <name>` | Skip one or more services (comma-separated or repeated). Mutually exclusive with `--only`. Only takes effect when starting a new stack (see "Running in the background" below). |
| `-o, --only <name>` | Start only these services (comma-separated or repeated), plus whatever they transitively `dependsOn`. Mutually exclusive with `--exclude`. Only takes effect when starting a new stack. |
| `--persist-logs` | Also write each service's captured output to `logs/<name>.log`. Off by default — logs live in memory only (up to 20,000 lines/service). Only takes effect when starting a new stack. |
| `--service-log` | Sets `LOGGING_FILE_NAME=service.log` in every service's env, for apps whose own internal logger can write to a file. Unrelated to `--persist-logs`. Only takes effect when starting a new stack. |
| `-h, --help` | Show usage (including your project's configured shortcuts). |

## Keyboard shortcuts

Always available: **q** / **Ctrl+C** stop everything (the stack and every
service in it), **b** background (close this view — the stack keeps running,
re-run vibestackr to reattach), **Shift+R** reload config (see `reload_config`
below) without restarting the stack, **Shift+O** show the status bar's full
overflow (any other key/click collapses it back to one line), **Tab** /
**←→** / **1-9** switch tabs, **↑↓** scroll one line, **Page Up/Down** scroll
a page, **Home/End** jump to top / back to the live tail. Plus whatever you
define in `shortcuts[]`.

## Running in the background

The actual stack (every spawned service) always runs as a background process
independent of any particular terminal window — `npx vibestackr` either
starts one for this project or finds one already running and opens a TUI
onto it. That split is what makes the following all work the way you'd
expect:

- **`npx vibestackr --background`** starts the stack without ever opening a
  TUI — useful for CI-adjacent scripts, or just to get it running and out of
  the way.
- **Closing the TUI doesn't stop anything.** Press **b** (or just start the
  stack with `--background` in the first place) and the stack keeps running
  after the TUI closes.
- **Running `npx vibestackr` again** in the same project attaches a TUI to
  the already-running stack instead of starting a second one — this is how
  you reopen a backgrounded (or accidentally-closed) stack.
- **`npx vibestackr stop`** actually stops everything — the counterpart to
  `q`/Ctrl+C, but from outside a TUI.
- **`npx vibestackr reload`** applies a config edit to the running stack
  without restarting it — the CLI counterpart to `reload_config`/Shift+R.

`--exclude`/`--only`/`--persist-logs`/`--service-log` only matter the moment
a *new* stack starts — they're meaningless when attaching to one that's
already running (its services were already decided), and vibestackr will warn
you if you pass them in that situation rather than silently ignoring them.

## MCP server

`vibestackr mcp` exposes the running stack to AI coding agents over the
[Model Context Protocol](https://modelcontextprotocol.io) — read logs, check
status, restart a service, or trigger a shortcut, without leaving your agent
session. It's a separate command/process from the TUI (and doesn't need one
running — the background stack is what it actually talks to); register it as
a project-scoped MCP server with your client (e.g. in `.mcp.json` in your
project root, so it's spawned with that project as its working directory):

```json
{
  "mcpServers": {
    "vibestackr": {
      "command": "npx",
      "args": ["vibestackr", "mcp"]
    }
  }
}
```

Check your specific MCP client's docs for exactly where project-scoped
server config lives and how working directory is determined — the important
part is that `vibestackr mcp` ends up running with your project as its
current directory, the same as the TUI itself.

The stack (started via `npx vibestackr` or `npx vibestackr --background`) needs
to actually be running in that project for tool calls to do anything — if it
isn't, you'll get a clear error instead of a hang. Tools:

| Tool | Description |
| --- | --- |
| `get_status` | Each service's current state (`starting`/`ready`/`failed`/`timeout`). |
| `get_logs` | A service's recent output (`name`, optional `lines` count). |
| `get_services` | Static, config-derived info per service — type, note, whether it has a `watcher`, oneShot, dependsOn, liveness type, whether it's included in this run, and current status. |
| `restart_service` | Restart (or start) a service by `name`. |
| `reload_config` | Re-read the config file and apply it to the running stack, without restarting it — new services start automatically; removed ones are left running (restart_service won't find them by that name anymore); an already-running service whose settings changed keeps its old ones until you restart_service it. |
| `list_shortcuts` | List configured shortcuts. |
| `run_shortcut` | Trigger a shortcut by its `key`. |

## License

MIT
