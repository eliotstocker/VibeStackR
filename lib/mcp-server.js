'use strict'

// `vibestakr mcp` — a separate process from the daemon (see bin/vibestakr
// and lib/attach-client.js), speaking MCP over stdio (so it works with
// standard MCP client configs). It never touches the engine directly: every
// tool call is translated into a request against the control socket the
// running daemon exposes via lib/control-socket.js. If no daemon is running
// for this project, the socket connection fails and each tool call returns a
// clear error instead of hanging or crashing this process.

const { z } = require('zod')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { requestSocket } = require('./control-socket')
const pkg = require('../package.json')

const textResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const errorResult = (err) => ({ content: [{ type: 'text', text: err.message }], isError: true })

function main() {
  const root = process.cwd()
  const server = new McpServer({
    name: 'vibestakr',
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
    description: "Re-read .vibestakr.json/.vibestakr.yaml from disk and apply it to the running daemon, without restarting it — e.g. after editing shortcuts/dependencies/warnings, or adding a new service (which gets started right away). Removing a service from config does NOT stop it if it's still running (restart_service won't find it anymore by that name afterward); an already-running service whose command/env/liveness changed keeps running with its old settings until you restart_service it. Fails with the schema validation error if the edited file is invalid.",
  }, async () => {
    try { return textResult(await requestSocket(root, 'reload_config', {})) } catch (err) { return errorResult(err) }
  })

  server.registerTool('list_shortcuts', {
    description: 'List the keyboard shortcuts configured for this project. Reflects the running daemon\'s current config — do not cache; call again if the config may have changed since.',
  }, async () => {
    try { return textResult(await requestSocket(root, 'shortcuts', {})) } catch (err) { return errorResult(err) }
  })

  server.registerTool('run_shortcut', {
    description: "Trigger a configured shortcut by its key, same as pressing that key in the TUI.",
    inputSchema: { key: z.string().describe("The shortcut's key, as configured in shortcuts[]") },
  }, async ({ key }) => {
    try { return textResult(await requestSocket(root, 'run_shortcut', { key })) } catch (err) { return errorResult(err) }
  })

  const transport = new StdioServerTransport()
  server.connect(transport).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { main }
