'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { formatJsonLogLine, escapeTags } = require('../lib/json-log')

test('returns null for a line that is not JSON at all', () => {
  assert.equal(formatJsonLogLine('Starting Gradle Daemon...', { format: '${message}' }), null)
})

test('returns null for JSON that is not a single object (array, primitive)', () => {
  assert.equal(formatJsonLogLine('[1,2,3]', { format: '${message}' }), null)
  assert.equal(formatJsonLogLine('42', { format: '${message}' }), null)
  assert.equal(formatJsonLogLine('null', { format: '${message}' }), null)
})

test('interpolates flat fields in order', () => {
  const line = JSON.stringify({ time: '12:00:00', level: 'info', message: 'hello' })
  const out = formatJsonLogLine(line, { format: '${time} ${level} ${message}' })
  assert.equal(out, '12:00:00 info hello')
})

test('supports @-prefixed field names (ECS convention, e.g. @timestamp)', () => {
  const line = JSON.stringify({ '@timestamp': '2026-01-01T00:00:00Z', message: 'hi' })
  const out = formatJsonLogLine(line, { format: '${@timestamp} ${message}' })
  assert.equal(out, '2026-01-01T00:00:00Z hi')
})

test('supports dot-path for nested fields', () => {
  const line = JSON.stringify({ message: 'hi', context: { requestId: 'abc-123' } })
  const out = formatJsonLogLine(line, { format: '${context.requestId} ${message}' })
  assert.equal(out, 'abc-123 hi')
})

test('missing field with no default becomes empty string', () => {
  const line = JSON.stringify({ message: 'hi' })
  const out = formatJsonLogLine(line, { format: '[${service}] ${message}' })
  assert.equal(out, '[] hi')
})

test('missing field falls back to ${field:-default}', () => {
  const line = JSON.stringify({ message: 'hi' })
  const out = formatJsonLogLine(line, { format: '[${service:-unknown}] ${message}' })
  assert.equal(out, '[unknown] hi')
})

test('object-valued fields are stringified as JSON (with braces escaped, same as any other substituted value)', () => {
  const line = JSON.stringify({ message: 'hi', context: { a: 1 } })
  const out = formatJsonLogLine(line, { format: '${message} ${context}' })
  assert.equal(out, 'hi {open}"a":1{close}')
})

test('field values containing { or } are escaped so they cannot be read as blessed tags', () => {
  const line = JSON.stringify({ message: 'error: {bad-tag} and }close' })
  const out = formatJsonLogLine(line, { format: '${message}' })
  assert.equal(out, 'error: {open}bad-tag{close} and {close}close')
})

test('colors the whole line by default level mapping (case-insensitive)', () => {
  const error = formatJsonLogLine(JSON.stringify({ level: 'ERROR', message: 'boom' }), { format: '${message}' })
  assert.equal(error, '{red-fg}boom{/red-fg}')

  const warn = formatJsonLogLine(JSON.stringify({ level: 'warn', message: 'careful' }), { format: '${message}' })
  assert.equal(warn, '{yellow-fg}careful{/yellow-fg}')

  const debug = formatJsonLogLine(JSON.stringify({ level: 'debug', message: 'noisy' }), { format: '${message}' })
  assert.equal(debug, '{grey-fg}noisy{/grey-fg}')
})

test('info level (and any level not in the map) is left uncolored', () => {
  const out = formatJsonLogLine(JSON.stringify({ level: 'info', message: 'fine' }), { format: '${message}' })
  assert.equal(out, 'fine')
})

test('no levelField present at all is left uncolored', () => {
  const out = formatJsonLogLine(JSON.stringify({ message: 'fine' }), { format: '${message}' })
  assert.equal(out, 'fine')
})

test('levelField can point at a different/nested field name', () => {
  const out = formatJsonLogLine(JSON.stringify({ severity: 'ERROR', message: 'boom' }), { format: '${message}', levelField: 'severity' })
  assert.equal(out, '{red-fg}boom{/red-fg}')
})

test('colors can be overridden/extended per service', () => {
  const out = formatJsonLogLine(JSON.stringify({ level: 'notice', message: 'fyi' }), { format: '${message}', colors: { notice: 'cyan' } })
  assert.equal(out, '{cyan-fg}fyi{/cyan-fg}')
})

test('escapeTags escapes braces for direct use on raw (non-JSON) lines', () => {
  assert.equal(escapeTags('plain text'), 'plain text')
  assert.equal(escapeTags('{red-fg}fake tag{/red-fg}'), '{open}red-fg{close}fake tag{open}/red-fg{close}')
})
