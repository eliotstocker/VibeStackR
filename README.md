# vibestakr

A portable TUI that brings up your entire local dev stack with one command —
services, dependency order, liveness checks, and keyboard shortcuts, all
driven by a single config file you drop into your project.

```
┌─ vibestakr ─────────────────────────────────────────────────────────────┐
│ [run-local] all required dependencies present                          │
│ [run-local] starting postgres (docker run, port 5432)                  │
│ [run-local] ✓ postgres ready                                            │
│ [run-local] starting api (http://localhost:4000)                       │
│ [run-local] ✓ api ready                                                 │
│ [run-local] starting web (http://localhost:5173)                       │
│ [run-local] all apps started — Ctrl+C to stop (or 'q'; 'r' restart api) │
└──────────────────────────────────────────────────────────────────────────┘
 q quit  Tab/←→ switch  ↑↓ scroll  r restart api
```

## Install & run

No install step needed — just run it in a project that has a
`run-local.config.json` (see below):

```sh
npx vibestakr
```

Or add it as a `devDependency` and wire up a script:

```sh
npm install --save-dev vibestakr
```

```json
{ "scripts": { "dev": "vibestakr" } }
```

## Quick start

Don't have a config yet? Let an AI coding agent write one for you by
inspecting your repo:

```sh
npx vibestakr init
```

This detects a coding CLI on your `PATH` (`opencode`, `pi`, `claude`,
`copilot`, `codex`, or `agy`, in that order) and hands it a prompt describing
the config format, or prints (and on macOS, copies) the prompt for you to
paste into whatever AI tool you use, if none of those are installed.

Or write `run-local.config.json` by hand — a minimal example:

```json
{
  "name": "MyApp",
  "services": [
    {
      "name": "postgres",
      "cwd": ".",
      "command": "sh",
      "args": ["-c", "docker start myapp-postgres 2>/dev/null || docker run -d --name myapp-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:16"],
      "oneShot": true,
      "liveness": { "type": "command", "command": "docker exec myapp-postgres pg_isready -U postgres" }
    },
    {
      "name": "api",
      "cwd": "api",
      "command": "npm",
      "args": ["run", "dev"],
      "note": "http://localhost:4000",
      "dependsOn": ["postgres"],
      "liveness": { "type": "http", "url": "http://localhost:4000/health" }
    }
  ]
}
```

Then just:

```sh
npx vibestakr
```

## Config reference

`run-local.config.json` (or `.yaml`/`.yml` — same shape either way) lives in
your project root. The full format is described by
[`schema/run-local.config.schema.json`](schema/run-local.config.schema.json)
— point your editor at it for autocomplete:

```json
{ "$schema": "node_modules/vibestakr/schema/run-local.config.schema.json" }
```

Top-level fields:

| Field | Description |
| --- | --- |
| `name` | Shown in the TUI's corner and terminal title. Defaults to `run-local`. |
| `services[]` | One entry per process vibestakr manages. |
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
| `dependsOn[]` | Other service names that must be ready before this one starts. |
| `liveness` | How vibestakr decides the service is ready — see below. |
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
`vibestakr mcp`'s `get_logs` tool all still see the original raw line.

## CLI flags

```
npx vibestakr [--exclude <name>[,<name>...]] [--only <name>[,<name>...]] [--persist-logs] [--service-log]
```

| Flag | Description |
| --- | --- |
| `-e, --exclude <name>` | Skip one or more services (comma-separated or repeated). Mutually exclusive with `--only`. |
| `-o, --only <name>` | Start only these services (comma-separated or repeated), plus whatever they transitively `dependsOn`. Mutually exclusive with `--exclude`. |
| `--persist-logs` | Also write each service's captured output to `logs/<name>.log`. Off by default — logs live in memory only (up to 20,000 lines/service). |
| `--service-log` | Sets `LOGGING_FILE_NAME=service.log` in every service's env, for apps whose own internal logger can write to a file. Unrelated to `--persist-logs`. |
| `-h, --help` | Show usage (including your project's configured shortcuts). |

## Keyboard shortcuts

Always available: **q** / **Ctrl+C** quit, **Tab** / **←→** / **1-9** switch
tabs, **↑↓** scroll one line, **Page Up/Down** scroll a page, **Home/End**
jump to top / back to the live tail. Plus whatever you define in
`shortcuts[]`.

## MCP server

`vibestakr mcp` exposes the running stack to AI coding agents over the
[Model Context Protocol](https://modelcontextprotocol.io) — read logs, check
status, restart a service, or trigger a shortcut, without leaving your agent
session. It's a separate command/process from the TUI; register it as a
project-scoped MCP server with your client (e.g. in `.mcp.json` in your
project root, so it's spawned with that project as its working directory):

```json
{
  "mcpServers": {
    "vibestakr": {
      "command": "npx",
      "args": ["vibestakr", "mcp"]
    }
  }
}
```

Check your specific MCP client's docs for exactly where project-scoped
server config lives and how working directory is determined — the important
part is that `vibestakr mcp` ends up running with your project as its
current directory, the same as the TUI itself.

The TUI (`npx vibestakr`) needs to actually be running in that project for
tool calls to do anything — if it isn't, you'll get a clear error instead of
a hang. Tools:

| Tool | Description |
| --- | --- |
| `get_status` | Each service's current state (`starting`/`ready`/`failed`/`timeout`). |
| `get_logs` | A service's recent output (`name`, optional `lines` count). |
| `restart_service` | Restart (or start) a service by `name`. |
| `list_shortcuts` | List configured shortcuts. |
| `run_shortcut` | Trigger a shortcut by its `key`. |

## License

MIT
