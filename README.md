# vibestackr

[![npm version](https://img.shields.io/npm/v/vibestackr.svg)](https://www.npmjs.com/package/vibestackr)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-%40eliotstocker%2Fvibestackr-blue?logo=github)](https://github.com/eliotstocker/VibeStackR/pkgs/npm/vibestackr)

A Simple UI, Task Runner, and MCP server that brings up your local stack in
dependency order, watches liveness, wires up keyboard shortcuts, and lets
your agent see exactly what you can see. All driven by a single config file
in your monorepo or meta-repo — your agent can write that config for you,
drive and observe the stack via MCP, and reload it on the fly, no restart
needed.

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

![demo](docs/demo.svg)

## Demo
Want to see it in action? Check out our [demo monorepo](https://github.com/eliotstocker/vibestackr-demo-monorepo).

## Install & run

No install step needed:

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

Don't have a config yet? Let an AI coding agent write one for you:

```sh
npx vibestackr init
```

## Subcommands

| Command | Description |
| --- | --- |
| `vibestackr` | Start the stack (or attach to one already running) and open the TUI. |
| `vibestackr init` | Hand an AI coding agent the job of writing `.vibestackr.yaml` from scratch by inspecting your repo. |
| `vibestackr config "<description>"` | Hand an agent a targeted edit to an existing config instead of a from-scratch rewrite. |
| `vibestackr mcp` | Run the MCP server, exposing the running stack to AI coding agents. |
| `vibestackr stop` | Stop the background stack and every service in it. |
| `vibestackr reload` | Apply a config edit to the running stack without restarting it. |

Flags (apply to the default/start command, and only take effect when
starting a *new* stack): `-c, --config <path>`, `-b, --background`,
`-e, --exclude <name>`, `-o, --only <name>`, `--persist-logs`,
`--service-log`. Run `vibestackr --help` for details, including your
project's own configured shortcuts.

## One YAML file, your whole stack

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

Full config reference: [`docs/config.md`](docs/config.md). Point your editor
at [`schema/config.schema.json`](schema/config.schema.json) for autocomplete via
`"$schema": "node_modules/vibestackr/schema/config.schema.json"`.

## Built for you *and* your AI coding agent

Not a human-facing Terminal UI with an API bolted on after the fact — the
agent-facing surface is a first-class citizen.

- `vibestackr init` hands an agent the job of writing your config in the first place.
- `vibestackr mcp` lets an agent read status/logs, restart a service, or trigger a shortcut mid-session, without leaving its own context.
- `vibestackr config "add a redis service on port 6379"` updates your config file using your installed agent CLI.

Your agent can now write code, restart the running service, check the
status, read the logs, debug the issue, and iterate.

## Keyboard shortcuts

Always available: **q** / **Ctrl+C** stop everything, **b** background
(stack keeps running, re-run vibestackr to reattach), **Shift+R** reload
config without restarting the stack, **Shift+S** pick a service to restart
from a popover list, **Shift+O** show the status bar's full overflow,
**Tab** / **←→** / **1-9** switch tabs, **↑↓** scroll one line, **Page
Up/Down** scroll a page, **Home/End** jump to top / back to the live tail.
Plus whatever you define in `shortcuts[]`.

## MCP server

`vibestackr mcp` exposes the running stack to AI coding agents over the
[Model Context Protocol](https://modelcontextprotocol.io): `get_status`,
`get_logs`, `get_services`, `restart_service`, `reload_config`,
`list_shortcuts`, `run_shortcut`. Register it as a project-scoped MCP server
(e.g. in `.mcp.json`, so it's spawned with your project as its working
directory):

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

The stack needs to actually be running in that project for tool calls to do
anything — if it isn't, you'll get a clear error instead of a hang.

## License

MIT
</content>
