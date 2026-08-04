'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildPrompt, buildUpdatePrompt, main, configMain, detectCli, CLI_INVOCATIONS, ensureMcpConfig } = require('../lib/init')

// detectCli() shells out to `sh -c "command -v <name>"`, which resolves
// against the CURRENT process's PATH — these tests manipulate PATH to
// control what's "installed" without ever touching the real, genuinely
// installed CLIs on this machine (several of the six are real here; we
// never want a test to actually kick off a real agent session).
function withPath(value, fn) {
  const prev = process.env.PATH
  process.env.PATH = value
  try {
    return fn()
  } finally {
    process.env.PATH = prev
  }
}

test('buildPrompt embeds the JSON schema, the example config, and the project root', () => {
  const prompt = buildPrompt('/some/project/root')
  assert.match(prompt, /"title": "vibestackr run-local config"/)
  assert.match(prompt, /"services"/)
  assert.match(prompt, /dependsOn/)
  assert.match(prompt, /\/some\/project\/root/)
  assert.match(prompt, /\.vibestackr\.json/)
})

test('buildPrompt with no shortcutDescriptions omits the shortcuts-ask section', () => {
  const prompt = buildPrompt('/some/project/root')
  assert.doesNotMatch(prompt, /asked for these shortcuts specifically/)
})

test('buildPrompt embeds each user-described shortcut, asking the agent to translate it into a shortcuts[] entry', () => {
  const prompt = buildPrompt('/some/project/root', ['r restarts the api service', 'p rebuilds the plugin jar'])
  assert.match(prompt, /asked for these shortcuts specifically/)
  assert.match(prompt, /- r restarts the api service/)
  assert.match(prompt, /- p rebuilds the plugin jar/)
})

test('CLI_INVOCATIONS build the confirmed non-interactive syntax for each CLI, in priority order', () => {
  const expected = [
    ['opencode', ['run', '--auto', 'PROMPT']],
    ['pi', ['-p', 'PROMPT']],
    ['claude', ['-p', '--permission-mode', 'acceptEdits', 'PROMPT']],
    ['copilot', ['--allow-all-tools', '-p', 'PROMPT']],
    ['codex', ['exec', 'PROMPT']],
    ['agy', ['--dangerously-skip-permissions', '-p', 'PROMPT']],
  ]
  assert.deepEqual(CLI_INVOCATIONS.map((c) => c.name), expected.map((e) => e[0]))
  for (const [name, args] of expected) {
    const cli = CLI_INVOCATIONS.find((c) => c.name === name)
    const built = cli.build('PROMPT')
    assert.equal(built.command, name)
    assert.deepEqual(built.args, args)
  }
})

test('detectCli finds a stubbed CLI ahead of nothing else on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-init-test-'))
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\necho fake\n')
  fs.chmodSync(path.join(dir, 'claude'), 0o755)
  try {
    withPath(`${dir}:/usr/bin:/bin`, () => {
      const cli = detectCli()
      assert.equal(cli.name, 'claude')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('detectCli respects CLI_INVOCATIONS priority order when multiple are "installed"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-init-test-'))
  for (const name of ['codex', 'claude', 'pi']) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho fake\n')
    fs.chmodSync(path.join(dir, name), 0o755)
  }
  try {
    withPath(`${dir}:/usr/bin:/bin`, () => {
      // pi comes before claude and codex in CLI_INVOCATIONS
      const cli = detectCli()
      assert.equal(cli.name, 'pi')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('detectCli returns null when none of the six are on PATH', () => {
  withPath('/usr/bin:/bin', () => {
    assert.equal(detectCli(), null)
  })
})

test('ensureMcpConfig writes .mcp.json and .agents/mcp_config.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-mcp-test-'))
  try {
    withPath('/usr/bin:/bin', () => {
      ensureMcpConfig(dir)
    })
    const mcpJson = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'))
    assert.deepEqual(mcpJson.mcpServers.vibestackr, { command: 'npx', args: ['vibestackr', 'mcp'] })

    const agentsMcpJson = JSON.parse(fs.readFileSync(path.join(dir, '.agents', 'mcp_config.json'), 'utf8'))
    assert.deepEqual(agentsMcpJson.mcpServers.vibestackr, { command: 'npx', args: ['vibestackr', 'mcp'] })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureMcpConfig writes .opencode/opencode.json when opencode is on PATH or .opencode exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-mcp-test-'))
  fs.writeFileSync(path.join(dir, 'opencode'), '#!/bin/sh\necho fake\n')
  fs.chmodSync(path.join(dir, 'opencode'), 0o755)
  try {
    withPath(`${dir}:/usr/bin:/bin`, () => {
      ensureMcpConfig(dir)
    })
    const opencodeJson = JSON.parse(fs.readFileSync(path.join(dir, '.opencode', 'opencode.json'), 'utf8'))
    assert.deepEqual(opencodeJson.mcp.vibestackr, { type: 'local', command: ['npx', 'vibestackr', 'mcp'], enabled: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureMcpConfig updates existing opencode.json in project root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-mcp-test-'))
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ mcp: { other: { type: 'local' } } }))
  try {
    withPath('/usr/bin:/bin', () => {
      ensureMcpConfig(dir)
    })
    const opencodeJson = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'))
    assert.deepEqual(opencodeJson.mcp.other, { type: 'local' })
    assert.deepEqual(opencodeJson.mcp.vibestackr, { type: 'local', command: ['npx', 'vibestackr', 'mcp'], enabled: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureMcpConfig does not overwrite custom vibestackr entry if already present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-mcp-test-'))
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { vibestackr: { command: 'custom' } } }))
  try {
    withPath('/usr/bin:/bin', () => {
      ensureMcpConfig(dir)
    })
    const mcpJson = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'))
    assert.equal(mcpJson.mcpServers.vibestackr.command, 'custom')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('vibestackr init --mcp updates MCP configs and exits cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-mcp-test-'))
  const origCwd = process.cwd()
  const origExit = process.exit
  let exitCode = null
  process.chdir(dir)
  process.exit = (code) => { exitCode = code; throw new Error('EXIT_TEST') }
  try {
    await assert.rejects(async () => {
      await main(['--mcp'])
    }, /EXIT_TEST/)
    assert.equal(exitCode, 0)
    assert.equal(fs.existsSync(path.join(dir, '.mcp.json')), true)
    assert.equal(fs.existsSync(path.join(dir, '.agents', 'mcp_config.json')), true)
  } finally {
    process.chdir(origCwd)
    process.exit = origExit
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('vibestackr init --agents updates AGENTS.md when config exists and exits cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-agents-test-'))
  fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify({ name: 'TestApp', services: [] }))
  const origCwd = process.cwd()
  const origExit = process.exit
  let exitCode = null
  process.chdir(dir)
  process.exit = (code) => { exitCode = code; throw new Error('EXIT_TEST') }
  try {
    await assert.rejects(async () => {
      await main(['--agents'])
    }, /EXIT_TEST/)
    assert.equal(exitCode, 0)
    const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
    assert.match(content, /## vibestackr/)
  } finally {
    process.chdir(origCwd)
    process.exit = origExit
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('vibestackr init --agents exits 1 when no stack config exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-agents-test-'))
  const origCwd = process.cwd()
  const origExit = process.exit
  let exitCode = null
  process.chdir(dir)
  process.exit = (code) => { exitCode = code; throw new Error('EXIT_TEST') }
  try {
    await assert.rejects(async () => {
      await main(['--agents'])
    }, /EXIT_TEST/)
    assert.equal(exitCode, 1)
  } finally {
    process.chdir(origCwd)
    process.exit = origExit
    fs.rmSync(dir, { recursive: true, force: true })
  }
})



