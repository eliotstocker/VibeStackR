'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildPrompt, detectCli, CLI_INVOCATIONS } = require('../lib/init')

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
  assert.match(prompt, /"title": "vibestakr run-local config"/)
  assert.match(prompt, /"services"/)
  assert.match(prompt, /dependsOn/)
  assert.match(prompt, /\/some\/project\/root/)
  assert.match(prompt, /run-local\.config\.json/)
})

test('CLI_INVOCATIONS build the confirmed non-interactive syntax for each CLI, in priority order', () => {
  const expected = [
    ['opencode', ['run', 'PROMPT']],
    ['pi', ['-p', 'PROMPT']],
    ['claude', ['-p', 'PROMPT']],
    ['copilot', ['-p', 'PROMPT']],
    ['codex', ['exec', 'PROMPT']],
    ['agy', ['-p', 'PROMPT']],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestakr-init-test-'))
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestakr-init-test-'))
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
