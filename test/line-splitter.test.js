'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('stream')
const { createLineSplitter, splitStream, splitText, MAX_LINE } = require('../lib/line-splitter')

function record() {
  const lines = []
  const partials = []
  const splitter = createLineSplitter({ onLine: (l) => lines.push(l), onPartial: (p) => partials.push(p) })
  return { splitter, lines, partials }
}

test('newline-terminated output splits into lines, blank lines preserved', () => {
  const { splitter, lines } = record()
  splitter.push('a\n\nb\n')
  assert.deepEqual(lines, ['a', '', 'b'])
})

test('a line written across several chunks commits once, whole', () => {
  const { splitter, lines, partials } = record()
  for (const c of ['Down', 'loading', '...', ' done\n']) splitter.push(c)
  assert.deepEqual(lines, ['Downloading... done'])
  // visible while still being written, cleared the moment it commits
  assert.deepEqual(partials, ['Down', 'Downloading', 'Downloading...', null])
})

test('\\r redraws collapse to their final frame — not one line per frame', () => {
  const { splitter, lines, partials } = record()
  for (let i = 0; i <= 100; i += 20) splitter.push(`\rprogress ${i}%`)
  splitter.push('\n')
  assert.deepEqual(lines, ['progress 100%'])
  assert.equal(partials.at(-2), 'progress 100%')
  assert.equal(partials.at(-1), null)
})

test('\\r\\n line endings are just line endings', () => {
  const { splitter, lines } = record()
  splitter.push('one\r\ntwo\r\n')
  assert.deepEqual(lines, ['one', 'two'])
})

test('a trailing \\r keeps the frame visible rather than blanking it', () => {
  const { splitter, lines, partials } = record()
  splitter.push('50%\r')
  assert.deepEqual(partials, ['50%'])
  splitter.push('\n')
  assert.deepEqual(lines, ['50%'])
})

test('cursor-to-column-1 and erase-line escapes behave like \\r, even split across chunks', () => {
  const { splitter, lines } = record()
  splitter.push('frame 1\x1b[2K\x1b[')
  splitter.push('1Gframe 2\x1b[2K\x1b[Gframe 3\n')
  assert.deepEqual(lines, ['frame 3'])
})

test('SGR color codes pass through untouched', () => {
  const { splitter, lines } = record()
  splitter.push('\x1b[32mok\x1b[0m\n')
  assert.deepEqual(lines, ['\x1b[32mok\x1b[0m'])
})

test('a bar that never prints \\n keeps pending bounded to its latest frame', () => {
  const { splitter, lines, partials } = record()
  for (let i = 0; i < 10000; i++) splitter.push(`\r${i}`)
  assert.equal(partials.at(-1), '9999')
  splitter.end()
  assert.deepEqual(lines, ['9999'])
})

test('end() commits a final line with no trailing newline, and clears the partial', () => {
  const { splitter, lines, partials } = record()
  splitter.push('no newline')
  splitter.end()
  assert.deepEqual(lines, ['no newline'])
  assert.equal(partials.at(-1), null)
})

test('end() with nothing pending (or only \\r) commits nothing', () => {
  const { splitter, lines } = record()
  splitter.push('x\n\r')
  splitter.end()
  assert.deepEqual(lines, ['x'])
})

test('onPartial only fires when the visible partial actually changes', () => {
  const { splitter, partials } = record()
  splitter.push('abc\r')
  splitter.push('\r')
  splitter.push('')
  assert.deepEqual(partials, ['abc'])
})

test('splitStream decodes a multi-byte UTF-8 character split across two reads', async () => {
  const stream = new PassThrough()
  const lines = []
  splitStream(stream, { onLine: (l) => lines.push(l) })
  const bytes = Buffer.from('✓ ready\n')
  stream.write(bytes.subarray(0, 2))
  stream.write(bytes.subarray(2))
  stream.end()
  await new Promise((r) => stream.on('end', r))
  assert.deepEqual(lines, ['✓ ready'])
})

test('splitText applies the same \\r semantics to fully-buffered output', () => {
  const lines = []
  splitText('\r10%\r50%\r100%\ndone', (l) => lines.push(l))
  assert.deepEqual(lines, ['100%', 'done'])
})

test('erase-line after a return-to-column-1 blanks the frame (a spinner clearing itself on stop)', () => {
  const { splitter, lines, partials } = record()
  splitter.push('\x1b[1G\x1b[0K⠋ Compiling')
  splitter.push('\x1b[1G\x1b[0K⠙ Compiling')
  splitter.push('\x1b[1G\x1b[0K')
  assert.equal(partials.at(-1), null) // not left showing the stale frame
  splitter.push('\n')
  assert.deepEqual(lines, ['']) // a real terminal would show a blank line here
})

test('erase-to-end mid-line (not parked at column 1) erases nothing visible', () => {
  const { splitter, lines } = record()
  splitter.push('keep\x1b[K me\n')
  assert.deepEqual(lines, ['keep me'])
})

test('megabytes with no newline stay linear-time, not quadratic', () => {
  const { splitter } = record()
  const chunk = '.'.repeat(1024)
  const start = process.hrtime.bigint()
  for (let i = 0; i < 5 * 1024; i++) splitter.push(chunk)
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  // The previous re-scan-everything version took ~4s here; linear is ~tens of ms.
  assert.ok(ms < 1000, `5MB without a newline took ${ms}ms`)
})

test('a line past MAX_LINE commits in MAX_LINE pieces instead of growing without bound', () => {
  const { splitter, lines, partials } = record()
  splitter.push('x'.repeat(MAX_LINE * 2 + 10))
  assert.equal(lines.length, 2)
  assert.ok(lines.every((l) => l.length === MAX_LINE))
  assert.equal(partials.at(-1).length, 10)
})
