# Config reference

`.vibestackr.yaml` (or `.vibestackr.yml`, `.vibestackr.json`, or `.vibestackr`
with no extension — same shape either way) lives in your project root. Pass
`--config <path>` instead to point at a differently-named or -located file.
The full format is described by
[`schema/config.schema.json`](../schema/config.schema.json)
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

## `services[]`

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

## `dependencies[]` / `warnings[]`

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

## `shortcuts[]`

```json
{ "key": "r", "label": "restart api", "restart": "api" }
{ "key": "g", "label": "regenerate clients", "command": "npm run generate:api", "cwd": "api" }
```

`restart` (name of a service to restart, or start if not running) and
`command` (a literal shell command, run with `cwd` relative to the project
root) are mutually exclusive.

## `jsonLog` — pretty-printing structured logs

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