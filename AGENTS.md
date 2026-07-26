# vibestakr

## What this is
A portable TUI tool that brings up an entire local dev stack with one
command. All of the stack's shape — services, their commands, dependency
order, liveness checks, env, warnings, keyboard shortcuts — lives in a
consumer-supplied `run-local.config.json` (or `.yaml`/`.yml`), not in this
repo. `vibestakr` is just the generic runner: spawn services, stream their
output into per-service tabs, poll liveness, show status
(starting/ready/failed/timeout), and wire up shortcuts (restart a service,
run a one-off command, etc).

This repo ships the runner only. There is no `run-local.config.json` here —
it's provided by whatever project drops `vibestakr` into itself.

## Layout
- `bin/vibestakr` — entry point. Routes subcommands: no arg → the TUI, `mcp`
  → the MCP server, `init` → agent-assisted config generation. Parses CLI
  flags for the TUI path (`--exclude`, `--only`, `--persist-logs`,
  `--service-log`).
- `lib/config.js` — finds and loads `run-local.config.(json|yaml|yml)` from
  the project root (`process.cwd()` at invocation — NOT `__dirname`, which
  would point into `node_modules` now that this runs via npx). Errors clearly
  if none or more than one exist.
- `lib/engine.js` — the orchestration engine: `status`/`children` maps,
  `spawnService`/`killService`/`restartService`/`runShortcut`, liveness
  polling, the declarative condition evaluator shared by `dependencies[]` and
  `warnings[]`, and the in-memory per-service log ring buffer. No
  blessed/rendering code lives here.
- `lib/ui.js` — the blessed TUI. One consumer of the engine's state; talks to
  it only through the object `createEngine()` returns.
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
  Runs inside the TUI process; exposes `status`/`logs`/`restart`/`shortcuts`/
  `run_shortcut` over a Unix domain socket at
  `~/.vibestakr/sockets/<sha1(realpath(root))>.sock`. See "MCP server" below
  for why that path (not something project-local) and why `os.homedir()`
  (not `os.tmpdir()`).
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
  project's `run-local.config.json` schema (`services[]`, `shortcuts[]`,
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
  `lib/control-socket.js`, `lib/mcp-server.js` (via a real MCP SDK client
  spawning the real subcommand), `lib/init.js`, and `bin/vibestakr`**
  (`test/`, run via `npm test` — Node's built-in `node --test`). `lib/ui.js`/
  `lib/logo.js` (blessed rendering) have no automated coverage and aren't a
  good target for it — verify UI/visual changes by actually running the tool
  against a real config and watching the TUI, not just by reading the diff.
  When testing `lib/init.js`, never let `detectCli()` actually find and
  invoke a real CLI — several of the six (`opencode`, `pi`, `claude`,
  `copilot`, `codex`, `agy`) are commonly actually installed, and invoking
  one for real kicks off a genuine agent session. Tests isolate this via a
  scoped `PATH` override, never the ambient one.

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

## MCP server
`vibestakr mcp` is a **separate subcommand/process**, not embedded in the TUI
process — it speaks MCP over stdio (so it works with standard MCP client
configs), which rules out sharing a process with the TUI (blessed already
owns stdin/stdout there). Instead:
- The running TUI process opens a **Unix domain socket** exposing the
  engine — status, logs (from the ring buffer), restart, shortcuts — all
  multiplexed over that one socket. Newline-delimited JSON request/response
  (`{id, method, params}` → `{id, result}` or `{id, error}`) is enough; no
  need for a heavier framework.
- `vibestakr mcp` (`lib/mcp-server.js`) is a thin client: it connects to that
  socket and translates MCP tool calls into socket requests. It does not
  duplicate any engine logic itself. 5 tools: `get_status`, `get_logs`,
  `restart_service`, `list_shortcuts`, `run_shortcut`.
- If the TUI isn't running, a tool call gets back a clear "vibestakr isn't
  running for this project — start it with `npx vibestakr` first" error
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
    tmpdir() made the TUI and `vibestakr mcp` compute two different, mutually
    unfindable base directories in practice (e.g. macOS's real per-user
    `/var/folders/.../T` vs a bare `/tmp` fallback). `os.homedir()` doesn't
    have this problem.
  - `realpathSync` (not just `path.resolve`) on the root matters too: two
    invocations of `process.cwd()` for "the same project" can differ if the
    path involves a symlink component, and a spawned child's reported cwd can
    come back fully resolved even when the path handed to it wasn't.
  If you ever touch `socketPath()` in `lib/control-socket.js`, re-verify
  against these three failure modes specifically, not just "does it work
  when I run both processes by hand from the same shell" — that case alone
  doesn't exercise any of them.
- A socket bind failure of any kind (already running, permission error,
  anything) must never be fatal to the TUI — `startControlSocket()` returns
  `{ok: false, reason}` rather than throwing; the caller logs a warning via
  `engine.warn()` and carries on. `vibestakr` (the TUI) always works
  standalone with no MCP client attached — the MCP server is an optional
  layer on top, never a dependency the runner requires to function.
- Scope for this pass: request/response snapshots only (e.g. "give me the
  last N log lines"), not live streaming/tailing over MCP.

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
