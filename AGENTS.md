# vibestakr

## What this is
A portable TUI tool that brings up an entire local dev stack with one
command. All of the stack's shape — services, their commands, dependency
order, liveness checks, env, warnings, keyboard shortcuts — lives in a
consumer-supplied `.vibestakr.json` (or `.vibestakr`/`.vibestakr.yaml`/
`.vibestakr.yml`, or an explicit `--config <path>`), not in this repo.
`vibestakr` is just the generic runner: spawn services, stream their
output into per-service tabs, poll liveness, show status
(starting/ready/failed/timeout), and wire up shortcuts (restart a service,
run a one-off command, etc).

The engine (the process actually spawning services and holding their
stdout/stderr pipes) always runs as a detached **daemon** with no TUI of its
own — see "Daemon / attach architecture" below. `npx vibestakr` either
starts one and attaches a TUI to it, or finds one already running for this
project and just attaches. This is what makes backgrounding (`--background`
or the `b` shortcut) and reattaching (running `npx vibestakr` again) the same
underlying mechanism rather than two separate features.

This repo ships the runner only. There is no `.vibestakr.json` here — it's
provided by whatever project drops `vibestakr` into itself.

## Layout
- `bin/vibestakr` — entry point. Routes subcommands: no arg → start-or-attach
  a TUI, `mcp` → the MCP server, `init` → agent-assisted config generation,
  `stop` → tell a running daemon to fully shut down. The default path always
  re-invokes itself as a detached `--daemon` (a hidden flag, not in `--help`)
  the first time, then either exits (`--background`) or attaches a TUI to
  it — see "Daemon / attach architecture" below. Parses CLI flags for the TUI
  path (`--config`, `--background`, `--exclude`, `--only`, `--persist-logs`,
  `--service-log`). `--config` is peeked at via a separate `partial: true`
  parse before the rest of `OPTION_DEFINITIONS` is even built, since the
  config's own `services[]` feeds the `--exclude`/`--only` help text.
- `lib/config.js` — finds and loads `.vibestakr.(json|yaml|yml)`/`.vibestakr`
  from the project root (`process.cwd()` at invocation — NOT `__dirname`,
  which would point into `node_modules` now that this runs via npx), or an
  explicit path passed as `loadConfig(root, explicitPath)` (resolved relative
  to `root` if not absolute). Errors clearly if none or more than one
  auto-discovered candidate exists, or if an explicit path doesn't exist. Only
  a `.yaml`/`.yml` extension is parsed as YAML — `.json` and no extension at
  all (plain `.vibestakr`) both parse as JSON.
- `lib/engine.js` — the orchestration engine: `status`/`children` maps,
  `spawnService`/`killService`/`restartService`/`runShortcut`, liveness
  polling, the declarative condition evaluator shared by `dependencies[]` and
  `warnings[]`, and the in-memory per-service log ring buffer. No
  blessed/rendering code lives here. Only ever instantiated inside the
  daemon process (`bin/vibestakr --daemon`) — a TUI never holds one directly.
- `lib/ui.js` — the blessed TUI. Doesn't know or care whether it's driven by
  a real `lib/engine.js` or `lib/attach-client.js`'s remote stand-in — both
  expose the same narrow surface it actually reads: a `status` Map,
  `included(name)`, and `runShortcut(shortcut)`.
- `lib/attach-client.js` — the remote counterpart to `lib/engine.js` that
  every TUI actually uses now (see "Daemon / attach architecture"): polls the
  daemon's control socket a few times a second for a status snapshot and new
  log lines (via the `tail` method's cursor, not re-fetching everything each
  tick) and feeds them into `lib/ui.js` exactly as the real engine would.
  `quit()` asks the daemon to fully stop; `detach()` just stops polling and
  leaves the daemon running — these back the `q` vs `b` shortcuts.
- `lib/logo.js` — the pink-to-orange gradient ASCII banner pinned atop the
  "vibestakr" (run-local) tab. Pure branding, no config surface.
- `lib/json-log.js` — pure formatting logic (no blessed dependency) for a
  service's `jsonLog` config: parses a line as JSON, builds the `format`
  template, applies level-based coloring. Returns `null` for anything that
  isn't a single JSON object, so the caller (`lib/ui.js`) falls back to the
  raw line. Purely a *display* transform — the ring buffer and
  `--persist-logs` file always keep the untouched raw line; only `lib/ui.js`
  reformats for rendering.
- `lib/control-socket.js` — the engine-facing side of the MCP integration.
  Runs inside the daemon process; exposes `status`/`logs`/`tail`/`restart`/
  `shortcuts`/`run_shortcut`/`quit` over a Unix domain socket at
  `~/.vibestakr/sockets/<sha1(realpath(root))>.sock`. Also exports
  `requestSocket(root, method, params)`, the client side of that same
  protocol — shared by `lib/mcp-server.js`, `lib/attach-client.js`, and
  `bin/vibestakr`'s own `stop` subcommand, rather than each reimplementing
  connect/write-one-line/read-one-line/close. See "Daemon / attach
  architecture" below for why the socket path is what it is (not something
  project-local) and why `os.homedir()` (not `os.tmpdir()`).
- `lib/mcp-server.js` — `vibestakr mcp`, a thin stdio MCP client for the
  socket above. Never touches the engine directly.
- `lib/init.js` — `vibestakr init`, agent-assisted config generation. Builds
  a prompt (embeds the JSON Schema + an annotated example), detects a coding
  CLI on `PATH`, and hands the prompt off to it. See "vibestakr init" below.
- `schema/run-local.config.schema.json` — JSON Schema for the config format,
  covering both JSON and YAML (same shape either way). Ships for editor
  autocomplete (`$schema` in a consumer's config), as the source of truth
  `lib/init.js` embeds directly into its generated prompt, **and** is
  enforced at runtime: `lib/config.js` compiles it once at module load
  (via `ajv`) and validates every loaded config against it, throwing a
  readable, multi-error message (not ajv's raw output) naming exactly which
  field(s) are wrong before anything else runs.

## Architecture constraints — read before editing
- **Distributed and run via `npx vibestakr`** (or as a `devDependency` +
  package-manager-run script), not by copy-pasting files around. `npm`/`npx`
  installs everything from `package.json` in the normal way — there is no
  self-bootstrap step. Because of this, splitting into the `bin/`+`lib/`
  layout above (rather than one monolithic file) is fine — consumers never
  touch these files directly.
- **Everything stack-specific is config, not code.** Adding a service, a
  shortcut, a dependency check, or a warning belongs in the consuming
  project's `.vibestakr.json` schema (`services[]`, `shortcuts[]`,
  `dependencies[]`, `warnings[]`), not hardcoded into `vibestakr`. If a task
  looks like "add support for X kind of service," ask whether it can be
  expressed as config first. (Two things that violated this — a hardcoded
  Gradle `settings.gradle` patch and a hardcoded `generateClients` shortcut
  built-in, both leftover from this tool's original single-project use — have
  been removed for exactly this reason.)
- **Logs are in-memory only by default.** Each service's captured
  stdout/stderr lives in a capped ring buffer (20,000 lines, in
  `lib/engine.js`) — nothing is written to disk unless `--persist-logs` is
  passed, in which case `logs/<name>.log` is also written (same as before).
  This buffer, not a log file, is what a future MCP `logs` query reads from —
  don't reintroduce an assumption that `logs/<name>.log` always exists.
- **Dev-only, interactive, TTY-owning.** `blessed` takes over the whole
  screen. There's intentionally no non-interactive/CI/pipe mode — don't add
  one speculatively.
- **Tests exist for `lib/config.js`, `lib/engine.js`, `lib/json-log.js`,
  `lib/control-socket.js`, `lib/attach-client.js`, `lib/mcp-server.js` (via a
  real MCP SDK client spawning the real subcommand), `lib/init.js`, and
  `bin/vibestakr`** (`test/`, run via `npm test` — Node's built-in
  `node --test`). `lib/ui.js`/`lib/logo.js` (blessed rendering) have no
  automated coverage and aren't a good target for it — verify UI/visual
  changes by actually running the tool against a real config and watching the
  TUI, not just by reading the diff.
  When testing `lib/init.js`, never let `detectCli()` actually find and
  invoke a real CLI — several of the six (`opencode`, `pi`, `claude`,
  `copilot`, `codex`, `agy`) are commonly actually installed, and invoking
  one for real kicks off a genuine agent session. Tests isolate this via a
  scoped `PATH` override, never the ambient one.
  `test/bin.test.js`'s daemon/background/reattach/stop tests always clean up
  via the real `stop` subcommand (or by asserting the daemon they started is
  actually gone) — SIGTERM to the spawned `vibestakr` process now only
  detaches a client, it does *not* stop the daemon (see "Daemon / attach
  architecture" below), so relying on it to reap child processes at the end
  of a test would leak a real background daemon + services per test run.

## Code style already established here
The existing code leans hard on comments that explain *why*, especially for
non-obvious ordering/timing decisions (e.g. why `readyPromises` must be fully
registered before any `startService()` runs, why `onReady` differs from
`onSuccess`). Match that: don't restate what a line does, explain the
constraint that made it necessary. Keep the terse, dense comment style rather
than prose blocks.

## Where things live (for orchestration logic)
- `status` (Map of name → starting/ready/failed/timeout) — the source of
  truth for a service's current state.
- `children` (Map of name → `{ proc, service, stopping }`) — the source of
  truth for what's actually running.
- `killService` / `restartService` / `spawnService` — the actual process
  lifecycle primitives.
- `getLogs(name, lines)` — reads the in-memory ring buffer for a service.
  This, not a file, is the source of truth for "what has this service
  printed recently."

## Daemon / attach architecture
`bin/vibestakr` splits into two roles that are always separate OS processes,
never combined in one:
- **The daemon** (`bin/vibestakr --daemon`, a hidden flag) — owns
  `lib/engine.js`, spawns every service, holds their stdout/stderr pipes, and
  hosts the control socket below. No blessed, no TTY. It's the only thing
  that actually needs to keep running for the stack to keep running.
- **A client** — either a TUI (`lib/ui.js` + `lib/attach-client.js`) or
  `vibestakr mcp` (`lib/mcp-server.js`). Cheap, disposable, talks to the
  daemon only through the socket, never touches `lib/engine.js` directly.

This is what makes several things fall out for free instead of needing
separate mechanisms:
- **`npx vibestakr`** checks whether a daemon is already running for this
  project (`isSocketAlive(socketPath(root))`); if not, it spawns one
  (detached, stdio redirected to `daemonLogPath(root)` since it has no
  terminal of its own) and waits for the socket to come alive — or for the
  daemon to exit early (e.g. a `checkDeps()` failure), whichever happens
  first, so a broken config fails fast instead of hanging. Either way, it
  then attaches a TUI to that daemon.
- **`--background`** does the same daemon start/discovery, then exits
  instead of attaching a TUI.
- **Reattaching** is just running `npx vibestakr` again — since a daemon was
  already found alive, it skips straight to attaching. Nothing about
  "starting" and "reattaching" is different code.
- **The `b` shortcut** (`lib/ui.js`) calls `attach.detach()` — stops this
  client's polling and destroys its own blessed screen, but never touches
  the daemon, which was always a separate process to begin with. `q` /
  Ctrl+C call `attach.quit()` instead, which asks the daemon to fully stop
  (see `quit` below) — deliberately a different action from `b`, so muscle
  memory on `q` can't accidentally take down a long-running background
  stack.
- **`vibestakr stop`** does exactly what `quit()` does, from a one-shot
  process instead of a TUI.
- `--exclude`/`--only`/`--persist-logs`/`--service-log` only matter at the
  moment a *new* daemon is started — they're meaningless once attaching to
  one that's already running (its services were already decided). `bin/
  vibestakr` prints a warning if any of them are passed while attaching to
  an existing daemon, rather than silently ignoring them.

**The control socket** (`lib/control-socket.js`) is what makes all of this
(and the pre-existing MCP integration) possible — a Unix domain socket at
`~/.vibestakr/sockets/<sha1(realpath(root))>.sock` exposing the running
daemon's engine. Newline-delimited JSON request/response (`{id, method,
params}` → `{id, result}` or `{id, error}`) is enough; no need for a heavier
framework. Methods: `status`, `logs` (a fixed last-N-lines snapshot — what
`vibestakr mcp`'s `get_logs` tool uses), `tail` (cursor-based — `{name,
since}` → `{lines, total}`, what `lib/attach-client.js` polls a few times a
second instead of re-fetching everything each tick — `total` comes from
`lib/engine.js`'s `logTotals`, a count that's monotonic and unaffected by the
ring buffer's own trimming, unlike `buf.length`), `services` (static,
config-derived info per service — type, note, `watcher`, oneShot, dependsOn,
liveness type, `included`, current `status` — as opposed to `status` above,
which is runtime-only), `restart`, `shortcuts`, `run_shortcut`, and `quit`
(defers the actual shutdown via `setImmediate` so its own `{ok: true}`
response has a chance to flush before the process serving it exits).
- `requestSocket(root, method, params)` (also in `lib/control-socket.js`) is
  the client side of that same protocol — shared by `lib/mcp-server.js`,
  `lib/attach-client.js`, and `bin/vibestakr`'s own `stop` subcommand, rather
  than each reimplementing connect/write-one-line/read-one-line/close.
- `vibestakr mcp` (`lib/mcp-server.js`) is a thin client: it connects to the
  socket and translates MCP tool calls into socket requests, never
  duplicating any engine logic itself. 6 tools: `get_status`, `get_logs`,
  `get_services`, `restart_service`, `list_shortcuts`, `run_shortcut`. If no
  daemon is running, a tool call gets back a clear "vibestakr isn't running
  for this project — start it with `npx vibestakr` first" error
  (`isError: true`) instead of hanging or crashing the MCP process.
- `restart`/`restart_service` validates the service name exists *before*
  calling `engine.restartService()` — that function itself silently no-ops
  for an unknown name (fine for a keyboard shortcut referencing a typo'd name
  in the project's own config), but an agent passing a typo'd name over MCP
  needs a real error, not a silent `{status: null}`.
- A line that fails to `JSON.parse` still gets *a* response (`{id: null,
  error: ...}`), never a silent drop — a client is always waiting on a
  trailing `\n` for whatever it just sent, and dropping the line entirely
  would hang it forever instead of erroring cleanly.
- **The socket lives at `~/.vibestakr/sockets/<sha1(realpath(root))>.sock` —
  NOT inside the project directory, and NOT under `os.tmpdir()`.** Both of
  these were tried first and both were real bugs, not style preferences:
  - A project-nested path (`<root>/.vibestakr/control.sock`) can exceed the
    ~104-byte Unix domain socket path limit on macOS/BSD on an entirely
    unremarkable deeply-nested checkout — `bind()` fails with `EINVAL`.
  - `os.tmpdir()` depends on `TMPDIR`. `vibestakr mcp` is normally launched
    by an MCP *client* (Claude Code, Cursor, etc.), not the user directly,
    and the standard stdio transport only forwards a small safe-list of env
    vars to the spawned process — `TMPDIR` isn't on it, `HOME` is. Using
    tmpdir() made the daemon and `vibestakr mcp` compute two different,
    mutually unfindable base directories in practice (e.g. macOS's real
    per-user `/var/folders/.../T` vs a bare `/tmp` fallback). `os.homedir()`
    doesn't have this problem.
  - `realpathSync` (not just `path.resolve`) on the root matters too: two
    invocations of `process.cwd()` for "the same project" can differ if the
    path involves a symlink component, and a spawned child's reported cwd can
    come back fully resolved even when the path handed to it wasn't.
  If you ever touch `socketPath()` in `lib/control-socket.js`, re-verify
  against these three failure modes specifically, not just "does it work
  when I run both processes by hand from the same shell" — that case alone
  doesn't exercise any of them.
- **A socket bind failure is fatal to the daemon** (`bin/vibestakr`'s
  `runDaemon()` logs an error and `process.exit(1)`s) — this is a deliberate
  departure from the old single-process design, where the socket was an
  optional layer a standalone TUI could run without. Now the socket is the
  daemon's *only* way to ever be reached again (by an attaching TUI,
  `vibestakr stop`, or `vibestakr mcp`); a daemon nobody can ever talk to
  again is useless, not merely degraded.
- Attach clients (TUI and MCP alike) get status/logs via **polling** (a few
  times a second — see `POLL_INTERVAL_MS` in `lib/attach-client.js`), not a
  push/subscribe channel. Piggybacking live push onto the socket's
  intentionally simple one-request-one-response protocol wasn't worth the
  complexity for a dev tool; a few hundred ms of latency on a new log line or
  status change is unnoticeable in practice.

## `vibestakr init`
Agent-assisted config generation. Embeds the JSON Schema + an annotated
example, instructs an agent to inspect the target repo and produce a valid
config. Detects a CLI on `PATH` in this order and auto-invokes it with the
prompt: `opencode`, `pi`, `claude`, `copilot`, `codex`, `agy` — falls back to
printing (and macOS `pbcopy`ing) the prompt if none are found.

Confirmed invocation syntax per CLI (all take the prompt as a single trailing
argument, no shell involved — avoids quoting/escaping issues entirely):
`opencode run "<prompt>"`, `pi -p "<prompt>"`, `claude -p "<prompt>"`,
`copilot -p "<prompt>"`, `codex exec "<prompt>"`, `agy -p "<prompt>"`. If any
of these CLIs changes its non-interactive flag in a future version, that's
the one place (`CLI_INVOCATIONS` in `lib/init.js`) to update — nothing else
depends on the specific flag shape.
