'use strict'

// Permanent banner pinned atop the "pipeline" (run-local) tab — pure
// branding, no config surface. Colored with a pink-to-orange gradient across
// each character's column, using blessed's per-tag hex color support
// (`{#rrggbb-fg}`) rather than the 16/256-color palette, so the gradient is
// smooth rather than banded.
const LOGO_LINES = [
  '_  _ _ ___  ____ ____ ___ ____ _  _ ____ ',
  '|  | | |__] |___ [__   |  |__| |_/  |__/ ',
  ' \\/  | |__] |___ ___]  |  |  | | \\_ |  \\',
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

module.exports = { LOGO, LOGO_HEIGHT, LOGO_WIDTH }
