'use strict'

// `vibestakr mcp` — a separate process from the TUI, speaking MCP over
// stdio (so it works with standard MCP client configs). It never touches the
// engine directly: every tool call is translated into a request against the
// control socket the running TUI (bin/vibestakr's default path) exposes via
// lib/control-socket.js. If the TUI isn't running for this project, the
// socket connection fails and each tool call returns a clear error instead
// of hanging or crashing this process.

const net = require('net')
const path = require('path')
const { z } = require('zod')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { socketPath } = require('./control-socket')
const pkg = require('../package.json')

const NOT_RUNNING_MESSAGE = "vibestakr isn't running for this project — start it with `npx vibestakr` first"

function callSocket(root, method, params) {
  return new Promise((resolve, reject) => {
    const sockPath = socketPath(root)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const sock = net.connect(sockPath)
    let buffer = ''

    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    sock.on('data', (chunk) => {
      buffer += chunk
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      const line = buffer.slice(0, idx)
      sock.end()
      try {
        const res = JSON.parse(line)
        if (res.error) reject(new Error(res.error))
        else resolve(res.result)
      } catch (err) {
        reject(err)
      }
    })
    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new Error(NOT_RUNNING_MESSAGE))
      else reject(err)
    })
  })
}

const textResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const errorResult = (err) => ({ content: [{ type: 'text', text: err.message }], isError: true })

function main() {
  const root = process.cwd()
  const server = new McpServer({ name: 'vibestakr', version: pkg.version })

  server.registerTool('get_status', {
    description: "Get each configured service's current state (starting/ready/failed/timeout).",
  }, async () => {
    try { return textResult(await callSocket(root, 'status', {})) } catch (err) { return errorResult(err) }
  })

  server.registerTool('get_logs', {
    description: "Read a service's recently captured output (in-memory ring buffer, up to 20,000 lines — the raw lines, not the TUI's display formatting).",
    inputSchema: {
      name: z.string().describe('Service name, as configured in services[]'),
      lines: z.number().int().positive().optional().describe('Number of most recent lines to return (default: everything buffered)'),
    },
  }, async ({ name, lines }) => {
    try { return textResult(await callSocket(root, 'logs', { name, lines })) } catch (err) { return errorResult(err) }
  })

  server.registerTool('restart_service', {
    description: 'Restart a configured service (or start it, if not already running).',
    inputSchema: { name: z.string().describe('Service name, as configured in services[]') },
  }, async ({ name }) => {
    try { return textResult(await callSocket(root, 'restart', { name })) } catch (err) { return errorResult(err) }
  })

  server.registerTool('list_shortcuts', {
    description: 'List the keyboard shortcuts configured for this project.',
  }, async () => {
    try { return textResult(await callSocket(root, 'shortcuts', {})) } catch (err) { return errorResult(err) }
  })

  server.registerTool('run_shortcut', {
    description: "Trigger a configured shortcut by its key, same as pressing that key in the TUI.",
    inputSchema: { key: z.string().describe("The shortcut's key, as configured in shortcuts[]") },
  }, async ({ key }) => {
    try { return textResult(await callSocket(root, 'run_shortcut', { key })) } catch (err) { return errorResult(err) }
  })

  const transport = new StdioServerTransport()
  server.connect(transport).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { main }
