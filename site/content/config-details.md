# Configuration Guide

This page covers every option available in `.vibestackr.yaml` (or `.vibestackr.json`, `.vibestack.yml`, `.vibestackr` with no extension) in depth, with worked examples. For a quick overview, see the [config section](index.html#config) on the main page.

## Full example

A stack with a database, an API that depends on it, and a web frontend:

```yaml
name: MyApp
services:
  - name: postgres
    cwd: .
    command: sh
    args: ["-c", "docker start myapp-postgres 2>/dev/null || docker run -d --name myapp-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:16"]
    oneShot: true
    liveness: { type: command, command: docker exec myapp-postgres pg_isready -U postgres }
    stopCommand: docker stop myapp-postgres
  - name: api
    cwd: api
    command: npm
    args: ["run", "dev"]
    type: node
    note: http://localhost:4000
    dependsOn: ["postgres"]
    envFile: api/.env
    liveness: { type: http, url: http://localhost:4000/health }
    onReady: echo "api is up"
  - name: web
    cwd: web
    command: npm
    args: ["run", "dev"]
    type: node
    note: http://localhost:3000
    dependsOn: ["api"]
    watcher: true
    liveness: { type: port, host: localhost, port: 3000 }
dependencies:
  - message: "Docker must be running"
    when:
      - commandFails: { command: docker, args: ["info"] }
warnings:
  - message: "DATABASE_URL not set — api will fall back to localhost"
    when:
      - envUnset: DATABASE_URL
    service: api
shortcuts:
  - key: m
    label: Run migrations
    command: npm run migrate
    cwd: api
  - key: s
    label: Seed database with a named fixture
    command: npm run seed -- ${fixture}
    cwd: api
    inputs:
      - name: fixture
        label: Fixture name
        default: default
```

---

## Top-level fields

### `name`
Brand shown in the TUI corner and terminal title.
**Default:** `run-local`

```yaml
name: MyApp
```

### `services[]`
Core: one object per managed process. All services are included by default — use `--exclude` / `--only` at runtime to scope a run.

```bash
vibestackr --only api,postgres
vibestackr --exclude web
```

### `dependencies[]`
Pre-startup checks that can abort the entire run. Each entry needs a `message` and an optional `when[]` (all conditions must be true — see [Condition types](#conditions)).

```yaml
dependencies:
  - message: "Node 20+ required"
    when:
      - commandFails: { command: node, args: ["-e", "process.exit(process.version.split('.')[0].slice(1)>=20?0:1)"] }
```

### `warnings[]`
Same shape as `dependencies[]` but non-fatal — printed at startup when conditions match. Can include a `service` field to scope the warning to one service (skipped entirely if that service is excluded from the run).

```yaml
warnings:
  - message: "Using default Stripe test key"
    when:
      - envUnset: STRIPE_SECRET_KEY
    service: api
```

### `shortcuts[]`
Single-key TUI actions. Each has `key`, `label`, and either `restart` (restarts a named service) or `command` (runs a shell command). Supports typed `inputs[]` for interactive prompts.

---

## Service fields (`services[].<field>`)

### `name` *(required)*
Unique identifier. Becomes the tab name, and is used in `dependsOn`, `--exclude`/`--only`, and shortcut references.

### `type`
Free-form label. When set to a framework name (`node`, `go`, `rust`, `python`), vibestackr runs an automatic first-run install under the service's `cwd` — `npm install`, `go mod download`, `cargo fetch`, or `uv sync`/`poetry install` — but only when the dependency folder (`node_modules`, etc.) is missing or the manifest has changed since the last run.

```yaml
- name: api
  type: node
  cwd: api
  command: npm
  args: ["run", "dev"]
```

### `cwd`
Working directory relative to the project root where the command runs.

### `command` *(required)*
Executable to spawn, e.g. `npm`, `sh`, `./gradlew`.

### `args[]`
Arguments passed to the command. Either a JSON array (needed when an argument itself contains spaces or shell metacharacters):

```yaml
args: ["-c", "echo hello && echo world"]
```

or a space-separated string for simple cases:

```yaml
args: run dev
```

### `env`
Object of key-value pairs merged into the service's environment, overriding both `process.env` and `envFile` on conflict.

```yaml
env:
  NODE_ENV: development
  PORT: "4000"
```

### `envFile`
Path to a `.env` file (relative to the project root) loaded into the service's env. Comments (`#`) and blank lines are skipped. A missing file is silently ignored. `env` wins over `envFile` on key conflicts.

```yaml
envFile: api/.env.local
```

### `note`
One-line description pinned atop the service's log tab — typically a URL or status string.

```yaml
note: http://localhost:4000
```

### `jsonLog`
Configures JSON-line formatting for services that emit structured logs (e.g. pino, winston, Spring Boot). Supports a `format` template with `${field}` and dot-path access, an optional `levelField` (colors the line: error=red, warn=yellow, debug=grey), and optional `colors` overrides. Raw lines are always preserved in the log buffer and on disk if `--persist-logs` is set — formatting only affects the TUI display.

```yaml
jsonLog:
  format: "${time} ${level} ${msg}"
  levelField: level
  colors:
    info: cyan
```

### `oneShot`
Set `true` for jobs that exit (builds, migrations, one-off container bootstrap). vibestackr treats these differently: it won't poll liveness unless one is explicitly set, and status flips to "ready" on success only if no liveness is configured.

```yaml
- name: migrate
  cwd: api
  command: npm
  args: ["run", "migrate"]
  oneShot: true
```

### `watcher`
Informational flag for services that handle their own file watching (nodemon, vite HMR, etc.). Tells MCP clients this service reloads without needing a restart.

### `autoRestart`
If a non-oneShot process exits unexpectedly, respawn it automatically with exponential backoff (1s → 2s → 4s → … → 30s cap). The backoff counter resets once a respawned instance stays up for 10 seconds. Not applied during daemon shutdown.

```yaml
autoRestart: true
```

### `dependsOn[]`
Other service names that must be ready before this one starts. Dependencies are evaluated declaratively — no service begins until everything it depends on has passed its liveness gate.

```yaml
dependsOn: ["postgres", "redis"]
```

### `liveness`
How vibestackr knows the service is actually ready — see [Liveness check types](#liveness) below. One of `type: port`, `type: http`, or `type: command`; each carries an optional `timeout` in seconds (default 300).

### `onSuccess`
Shell command that fires once if this `oneShot` service exits with code 0. Fires on process exit regardless of any liveness setting.

```yaml
onSuccess: echo "migration complete"
```

### `onReady`
Shell command that fires once this service passes its liveness check (or immediately for `oneShot` services without liveness). Skipped entirely if liveness times out or fails.

```yaml
onReady: curl -s http://localhost:4000/warmup
```

### `stopCommand`
Shell command run in `cwd` when the service is stopped (restart, TUI 'reload', or shutdown). Use for cleanup of anything that outlives the spawned process, like a docker container.

```yaml
stopCommand: docker stop myapp-postgres
```

---

## Liveness check types

<a id="liveness"></a>

### `{ type: "port", host, port, timeout? }`
Succeeds when a TCP connection to `host`:`port` succeeds. Default timeout: 300s.

```yaml
liveness: { type: port, host: localhost, port: 5432, timeout: 60 }
```

### `{ type: "http", url, timeout? }`
Succeeds when an HTTP GET to `url` returns a 2xx or 3xx response. Default timeout: 300s.

```yaml
liveness: { type: http, url: http://localhost:4000/health }
```

### `{ type: "command", command, timeout? }`
Succeeds when the shell command exits with code 0. Default timeout: 300s. Prefer `oneShot: true` on services that don't need a real readiness gate — their status will just reflect the process exit code.

```yaml
liveness: { type: command, command: docker exec myapp-postgres pg_isready -U postgres, timeout: 30 }
```

---

## Condition types (for `dependencies[]` and `warnings[]`)

<a id="conditions"></a>

All conditions use a declarative shape. When listed under `when[]`, they're ANDed together — every condition must hold for the dependency/warning to fire.

### `{ envSet: "VAR" }`
Fires when the environment variable exists (any value, including empty string).

```yaml
when:
  - envSet: DATABASE_URL
```

### `{ envUnset: "VAR" }`
Fires when the environment variable does not exist.

### `{ envNotIn: { var: "X", values: ["a", "b"] } }`
Fires when the variable's current value is not one of the listed values.

```yaml
when:
  - envNotIn: { var: NODE_ENV, values: ["development", "test"] }
```

### `{ commandExists: "node" }`
Fires when the named executable is found on `PATH`.

### `{ commandMissing: "npm" }`
The opposite of `commandExists` — fires when the executable is NOT on `PATH`.

### `{ commandFails: { command: "...", args: [...] } }`
Fires when the given command exits with a non-zero code.

```yaml
when:
  - commandFails: { command: docker, args: ["info"] }
```

### `{ included: "serviceName" }`, `{ excluded: "serviceName" }`, `{ anyIncluded: ["a", "b"] }`
Fire based on whether a service is currently included/excluded from the run (e.g. via `--exclude`/`--only`). Useful for context-aware warnings — e.g. warn only when a dependency service has been excluded.

```yaml
warnings:
  - message: "api excluded — web will fail to load data"
    when:
      - excluded: api
    service: web
```

---

## Shortcut fields (`shortcuts[].<field>`)

### `key` *(required)*
The single character that triggers the shortcut in the TUI.

### `label` *(required)*
Appears in the bottom status bar and `--help`.

### `restart`
A service name. Restarts (or starts, if not running) that service when pressed. Mutually exclusive with `command`.

```yaml
- key: r
  label: Restart api
  restart: api
```

### `command`
Shell command to run (supports `${name}` substitution from `inputs[]`). Mutually exclusive with `restart`. Can be paired with `cwd` for a working directory.

### `inputs[]`
Makes the shortcut interactive. Each entry needs a `name`, and optional `label`, `placeholder`, and/or `default`. The TUI shows a text box per input; the MCP `run_shortcut` tool gains typed parameters. Collected values substitute into `command` by their `name`.

```yaml
- key: s
  label: Seed database with a named fixture
  command: npm run seed -- ${fixture}
  cwd: api
  inputs:
    - name: fixture
      label: Fixture name
      placeholder: e.g. large-dataset
      default: default
```

---

## Config format options

- `.vibestackr.yaml` or `.vibestack.yml` — parsed as YAML
- `.vibestackr.json` or `.vibestackr` (no extension) — parsed as JSON
- `--config path` — load any known format by explicit path

The schema lives at [schema/config.schema.json](https://github.com/eliotstocker/VibeStackR/blob/main/schema/config.schema.json); it's also what editor autocomplete and `vibestackr init` use as the source of truth.
