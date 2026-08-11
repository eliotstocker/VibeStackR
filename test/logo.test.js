'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { LOGO, LOGO_HEIGHT, LOGO_WIDTH, LOGO_ANSI, gradientSegments, gradientAnsiAt } = require('../lib/logo')

test('logo exports valid ANSI and blessed string representations', () => {
  assert.equal(typeof LOGO, 'string')
  assert.ok(LOGO_HEIGHT > 0)
  assert.ok(LOGO_WIDTH > 0)
  assert.equal(typeof LOGO_ANSI, 'string')
})

test('gradientAnsiAt returns ANSI colorized string at t', () => {
  const colored = gradientAnsiAt('text', 0.5)
  assert.match(colored, /\x1b\[38;2;\d+;\d+;\d+mtext\x1b\[0m/)
})

test('gradientSegments formats segments with gradient colors', () => {
  const result = gradientSegments([
    { text: 'hello', bold: true },
    { text: 'world', fg: 'red' },
  ])
  assert.match(result, /\{bold\}/)
  assert.match(result, /\{red-fg\}/)
})
