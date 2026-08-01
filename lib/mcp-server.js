'use strict'

// `vibestackr mcp` — a separate process from the daemon (see bin/vibestackr
// and lib/attach-client.js), speaking MCP over stdio (so it works with
// standard MCP client configs). It never touches the engine directly: every
// tool call is translated into a request against the control socket the
// running daemon exposes via lib/control-socket.js. If no daemon is running
// for this project, the socket connection fails and each tool call returns a
// clear error instead of hanging or crashing this process.

const { z } = require('zod')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { requestSocket, socketPath, daemonLogPath, isSocketAlive } = require('./control-socket')
const { startDaemon, stopDaemon } = require('./daemon')
const { findProjectRoot } = require('./config')
const pkg = require('../package.json')
const configSchema = require('../schema/config.schema.json')

const textResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const errorResult = (err) => ({ content: [{ type: 'text', text: err.message }], isError: true })

function main() {
  // Walks upward from cwd for the project's config, same as bin/vibestackr —
  // an MCP client may well launch this with cwd set to some subdirectory of
  // the project, and it still needs to hash the same root the daemon itself
  // was started against to find its control socket.
  const root = findProjectRoot(process.cwd())
  const server = new McpServer({
    name: 'vibestackr',
    version: pkg.version,
    // Applies to get_status/get_logs/get_services/list_shortcuts below —
    // repeated per-tool too (some clients only surface individual tool
    // descriptions to the model, not these server-level instructions), but
    // stated once here as the actual reason: this is a live dev stack a
    // human (or another process) can restart/crash/redeploy at any moment,
    // so a result from even a few seconds ago can already be wrong. Always
    // call the tool again for current state — never reuse an earlier
    // result from this conversation.
    instructions: "This server reflects a locally running dev stack's LIVE state (service status, logs, shortcuts) — nothing it returns is safe to cache or reuse across turns. Call the relevant tool again each time you need current status/logs, even if you called it moments ago in this same conversation.",
  })

  server.registerTool('start_daemon', {
    description: "Start the vibestackr daemon for this project if one isn't already running — spawns it detached in the background, same as `npx vibestackr --background`. Every other tool here (get_status, restart_service, etc) needs a running daemon to talk to; call this first if they're erroring with \"vibestackr isn't running for this project\".",
  }, async () => {
    try {
      if (await isSocketAlive(socketPath(root))) return textResult({ ok: true, already_running: true })
      const result = await startDaemon(root, [])
      if (!result.ok) throw new Error(`failed to start — see ${daemonLogPath(root)} for details`)
      return textResult({ ok: true, pid: result.pid })
    } catch (err) { return errorResult(err) }
  })

  server.registerTool('stop_daemon', {
    description: "Fully stop the daemon and every service it manages for this project, same as `npx vibestackr stop`. Distinct from restart_service, which only restarts a single service — this tears down the whole stack, and every other tool here will error until start_daemon is called again.",
  }, async () => {
    try {
      await stopDaemon(root)
      return textResult({ ok: true })
    } catch (err) { return errorResult(err) }
  })

  server.registerTool('get_config_schema', {
    description: "Get the JSON Schema for .vibestackr.json/.vibestackr.yaml — every valid field, type, and constraint for services/shortcuts/etc. Static (ships with this package version), unlike get_services/get_status. Use before writing or editing a project's config, e.g. via reload_config.",
  }, async () => {
    return textResult(configSchema)
  })

  server.registerTool('get_status', {
    description: "Get each configured service's current state (starting/ready/failed/timeout). Live snapshot — do not cache; call again each time you need current status, it can change at any moment.",
  }, async () => {
    try { return textResult(await requestSocket(root, 'status', {})) } catch (err) { return errorResult(err) }
  })

  server.registerTool('get_logs', {
    description: "Read a service's recently captured output (in-memory ring buffer, up to 20,000 lines — the raw lines, not the TUI's display formatting). Live/growing — do not cache; call again to get lines emitted since your last call.",
    inputSchema: {
      name: z.string().describe('Service name, as configured in services[]'),
      lines: z.number().int().positive().optional().describe('Number of most recent lines to return (default: everything buffered)'),
    },
  }, async ({ name, lines }) => {
    try { return textResult(await requestSocket(root, 'logs', { name, lines })) } catch (err) { return errorResult(err) }
  })

  server.registerTool('get_services', {
    description: "Get static, config-derived info about each configured service — type, note, whether it has a `watcher` (auto-restarts/reloads itself on file changes, e.g. nodemon or vite HMR), oneShot, dependsOn, liveness type, whether it's included in this run (--exclude/--only), and its current status. Most fields are static, but `status` isn't — do not cache this result, call again if you need current status.",
  }, async () => {
    try { return textResult(await requestSocket(root, 'services', {})) } catch (err) { return errorResult(err) }
  })

  server.registerTool('restart_service', {
    description: 'Restart a configured service (or start it, if not already running).',
    inputSchema: { name: z.string().describe('Service name, as configured in services[]') },
  }, async ({ name }) => {
    try { return textResult(await requestSocket(root, 'restart', { name })) } catch (err) { return errorResult(err) }
  })

  server.registerTool('reload_config', {
    description: "Re-read .vibestackr.json/.vibestackr.yaml from disk and apply it to the running daemon, without restarting it — e.g. after editing shortcuts/dependencies/warnings, or adding a new service (which gets started right away). Removing a service from config does NOT stop it if it's still running (restart_service won't find it anymore by that name afterward); an already-running service whose command/env/liveness changed keeps running with its old settings until you restart_service it. Fails with the schema validation error if the edited file is invalid.",
  }, async () => {
    try { return textResult(await requestSocket(root, 'reload_config', {})) } catch (err) { return errorResult(err) }
  })

  server.registerTool('list_shortcuts', {
    description: 'List the keyboard shortcuts configured for this project, including each one\'s `inputs` (if any) — the named values an interactive shortcut expects via run_shortcut\'s own `inputs` parameter. Reflects the running daemon\'s current config — do not cache; call again if the config may have changed since.',
  }, async () => {
    try { return textResult(await requestSocket(root, 'shortcuts', {})) } catch (err) { return errorResult(err) }
  })

  server.registerTool('run_shortcut', {
    description: "Trigger a configured shortcut by its key, same as pressing that key in the TUI. If the shortcut has `inputs` (call list_shortcuts first to check), pass a value for each one's `name` in `inputs` — same as filling in the TUI's own input popover for it.",
    inputSchema: {
      key: z.string().describe("The shortcut's key, as configured in shortcuts[]"),
      inputs: z.record(z.string()).optional().describe("Values for this shortcut's inputs[] (see list_shortcuts), keyed by each input's `name`. Ignored/unnecessary for a shortcut with no inputs[]."),
    },
  }, async ({ key, inputs }) => {
    try { return textResult(await requestSocket(root, 'run_shortcut', { key, inputs })) } catch (err) { return errorResult(err) }
  })

  const transport = new StdioServerTransport()
  server.connect(transport).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { main }
