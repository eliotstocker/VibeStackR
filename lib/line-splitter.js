'use strict'

// Splits a child's raw stdout/stderr byte stream into log lines, replacing
// Node's readline — which ends a line on a bare `\r` as well as `\n`, so
// every frame of a `\r`-redrawn progress bar/spinner (npm, gradle, curl,
// pip, docker pull...) landed in the ring buffer as its own line: the "same
// line repeated N times" effect. Here `\r` means what it means on a real
// terminal — "overwrite this line" — so a line only ever commits on `\n`, as
// whatever its final frame was.
//
// Text after the last `\n` (a line still being written — a progress bar
// mid-redraw, or `Compiling...` waiting on its ` done`) is reported through
// onPartial as it changes, rather than invisible until its `\n` arrives.
// It's ephemeral display state only: never in the ring buffer, never in
// --persist-logs, and superseded by the committed line once it does end.
//
// A tiny line-oriented terminal model, one pass per chunk — never re-scanning
// what's already buffered, since a service can write megabytes with no `\n`
// (a minified JSON dump, dot-per-test output) and this runs on the daemon's
// only event loop. Only the handful of controls that make sense for "one
// line being redrawn" are interpreted:
//  - `\r`, CSI G / 0G / 1G (cursor to column 1): park the cursor. The frame
//    stays visible — a terminal doesn't blank a line just because the
//    cursor moved — until new text replaces it.
//  - CSI 2K / 1K (erase whole line / up to cursor): blank the frame. CSI K /
//    0K (erase to end) blanks it only while parked at column 1; mid-line
//    it erases nothing we'd be showing.
// Not a character-level overwrite of shorter frames onto longer ones —
// redraw-style output rewrites the full width anyway, and column math would
// be wrong the moment an SGR color code is involved. Cursor-up multi-line
// redraws (CSI nA — listr, docker compose's per-layer bars) can't be
// expressed as "overwrite the current line" and are deliberately left alone.
//
// Pure, no engine/blessed dependency — see test/line-splitter.test.js.

const TOKEN = /\n|\r|\x1b\[([01]?)G|\x1b\[([012]?)K/g
// An escape sequence cut off at a chunk boundary is held back until the next
// chunk, so e.g. `\x1b[2` + `K` still reads as one erase.
const INCOMPLETE_ESC = /\x1b(\[[0-9]*)?$/
// A line past this length (no `\n` in sight) is committed as-is and a new
// one started — keeps a runaway line from growing without bound in memory
// and from being shipped whole as the partial on every attach-client poll.
const MAX_LINE = 64 * 1024

function createLineSplitter({ onLine, onPartial = () => {} }) {
  let frame = ''
  let parked = false // cursor at column 1: next text starts a fresh frame
  let carry = ''
  let reported = null

  function text(t) {
    if (!t) return
    if (parked) { frame = t; parked = false } else frame += t
    while (frame.length > MAX_LINE) {
      onLine(frame.slice(0, MAX_LINE))
      frame = frame.slice(MAX_LINE)
    }
  }
  function commit() {
    onLine(frame)
    frame = ''
    parked = false
  }

  function consume(chunk) {
    TOKEN.lastIndex = 0
    let last = 0
    let m
    while ((m = TOKEN.exec(chunk))) {
      text(chunk.slice(last, m.index))
      last = TOKEN.lastIndex
      if (m[0] === '\n') commit()
      else if (m[0] === '\r' || m[1] !== undefined) parked = true
      else if (m[2] === '2' || m[2] === '1' || parked) frame = ''
    }
    text(chunk.slice(last))
  }

  function reportPartial() {
    const next = frame || null
    if (next === reported) return
    reported = next
    onPartial(next)
  }

  function push(chunk) {
    let data = carry + chunk
    const esc = data.match(INCOMPLETE_ESC)
    carry = esc ? esc[0] : ''
    if (esc) data = data.slice(0, esc.index)
    consume(data)
    reportPartial()
  }

  // Stream closed: a final line with no trailing `\n` (common — `printf`,
  // or a process killed mid-write) still commits, same as readline did.
  function end() {
    text(carry)
    carry = ''
    if (frame) commit()
    reportPartial()
  }

  return { push, end }
}

// Convenience for a stream.Readable (child stdout/stderr). setEncoding()
// (not per-chunk toString) so a multi-byte UTF-8 character split across two
// reads decodes correctly, same guarantee readline gave.
function splitStream(stream, handlers) {
  const splitter = createLineSplitter(handlers)
  stream.setEncoding('utf8')
  stream.on('data', splitter.push)
  stream.on('end', splitter.end)
  return splitter
}

// For already-fully-buffered output (spawnSync's stdout/stderr) — same
// `\r` semantics, no partial reporting since there's nothing still arriving.
function splitText(text, onLine) {
  const splitter = createLineSplitter({ onLine })
  splitter.push(text)
  splitter.end()
}

module.exports = { createLineSplitter, splitStream, splitText, MAX_LINE }
