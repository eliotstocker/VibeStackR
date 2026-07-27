'use strict'

// Permanent banner pinned atop the "pipeline" (run-local) tab — pure
// branding, no config surface. Colored with a pink-to-orange gradient across
// each character's column, using blessed's per-tag hex color support
// (`{#rrggbb-fg}`) rather than the 16/256-color palette, so the gradient is
// smooth rather than banded.
// V I B E S T A C K R — the "C" is the only new glyph vs. the old VIBESTAKR
// wordmark (same font/columns for every other letter).
const LOGO_LINES = [
  '_  _ _ ___  ____ ____ ___ ____  ___ _  _ ____ ',
  '|  | | |__] |___ [__   |  |__| /    |_/  |__/ ',
  ' \\/  | |__] |___ ___]  |  |  | \\___ | \\_ |  \\ ',
]

const GRADIENT_FROM = [0xff, 0x6e, 0xc7] // pink
const GRADIENT_TO = [0xff, 0xa5, 0x00] // orange

const hex2 = (n) => n.toString(16).padStart(2, '0')
const lerp = (a, b, t) => Math.round(a + (b - a) * t)

// Escapes defensively even though none of the ASCII-art source characters are
// literal braces — this is rendered in a tags:true box.
const escapeTags = (ch) => (ch === '{' ? '{open}' : ch === '}' ? '{close}' : ch)

function gradientLine(line, width) {
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const t = width > 1 ? i / (width - 1) : 0
    const color = `#${hex2(lerp(GRADIENT_FROM[0], GRADIENT_TO[0], t))}${hex2(lerp(GRADIENT_FROM[1], GRADIENT_TO[1], t))}${hex2(lerp(GRADIENT_FROM[2], GRADIENT_TO[2], t))}`
    out += `{${color}-fg}${escapeTags(line[i])}{/${color}-fg}`
  }
  return out
}

const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => l.length))
const LOGO_HEIGHT = LOGO_LINES.length
const LOGO = `{bold}${LOGO_LINES.map((line) => gradientLine(line, LOGO_WIDTH)).join('\n')}{/bold}`

// Same gradient, plain truecolor ANSI escapes instead of blessed tags — for
// printing straight to the terminal (via console.log/process.stdout) before
// any blessed screen exists yet, e.g. bin/vibestackr's daemon-starting splash.
function gradientLineAnsi(line, width) {
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const t = width > 1 ? i / (width - 1) : 0
    const r = lerp(GRADIENT_FROM[0], GRADIENT_TO[0], t)
    const g = lerp(GRADIENT_FROM[1], GRADIENT_TO[1], t)
    const b = lerp(GRADIENT_FROM[2], GRADIENT_TO[2], t)
    out += `\x1b[1m\x1b[38;2;${r};${g};${b}m${line[i]}`
  }
  return `${out}\x1b[0m`
}
const LOGO_ANSI = LOGO_LINES.map((line) => gradientLineAnsi(line, LOGO_WIDTH)).join('\n')

// Same pink-to-orange gradient, one truecolor ANSI-wrapped chunk at a single
// point `t` (0..1) rather than spread across a line — for something that
// itself moves/animates over time instead of having a fixed width, e.g.
// lib/init.js's spinner (t cycles frame-to-frame there, not position-to-
// position like the uses above).
function gradientAnsiAt(text, t) {
  const r = lerp(GRADIENT_FROM[0], GRADIENT_TO[0], t)
  const g = lerp(GRADIENT_FROM[1], GRADIENT_TO[1], t)
  const b = lerp(GRADIENT_FROM[2], GRADIENT_TO[2], t)
  return `\x1b[1m\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`
}

// Colors a run of text with the same pink-to-orange gradient as LOGO above,
// character-by-character across the *whole* concatenated `segments` (not
// per-segment) so e.g. the status bar reads as one continuous gradient
// rather than restarting for each piece — exported for lib/ui.js's status
// bar to reuse. Each segment is `{text, bold, fg}`: `bold` wraps just that
// segment's own chunk in {bold}/{/bold} (e.g. so a shortcut's key stands out
// from its label); `fg` overrides the gradient foreground with a fixed
// color for that segment (e.g. status counts keeping their own
// green/yellow/red meaning) instead of taking part in the shared gradient.
function gradientSegments(segments) {
  const totalLen = segments.reduce((n, s) => n + s.text.length, 0)
  let i = 0
  let out = ''
  for (const seg of segments) {
    let chunk = ''
    for (const ch of seg.text) {
      const t = totalLen > 1 ? i / (totalLen - 1) : 0
      const fg = seg.fg ?? `#${hex2(lerp(GRADIENT_FROM[0], GRADIENT_TO[0], t))}${hex2(lerp(GRADIENT_FROM[1], GRADIENT_TO[1], t))}${hex2(lerp(GRADIENT_FROM[2], GRADIENT_TO[2], t))}`
      chunk += `{${fg}-fg}${escapeTags(ch)}{/${fg}-fg}`
      i++
    }
    out += seg.bold ? `{bold}${chunk}{/bold}` : chunk
  }
  return out
}

module.exports = { LOGO, LOGO_HEIGHT, LOGO_WIDTH, LOGO_ANSI, gradientSegments, gradientAnsiAt }
