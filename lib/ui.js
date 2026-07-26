'use strict'

const blessed = require('blessed')
const { STATE_COLOR, STATE_GLYPH } = require('./engine')
const { formatJsonLogLine, escapeTags } = require('./json-log')
const { LOGO, LOGO_HEIGHT } = require('./logo')

// One tab per service (+ a "run-local" tab for setup/shortcut output) and a
// status bar, all in THIS process — no child process, no fifo, no log-file
// tailing; it just renders the lines this process already has in memory.
// This is a dev-only interactive tool so there's no non-TTY fallback — pipe/
// CI usage isn't a supported mode.
function createUI({ config, engine, onQuit }) {
  // "run-local" is the internal key/tab for this script's own setup/shortcut
  // output (log()/warn()/runSync's default target) — config.name only
  // changes what's displayed for it (brand corner + tab label), not the key.
  const BRAND = config.name || 'run-local'
  const displayName = (name) => (name === 'run-local' ? 'vibestakr' : name)
  const noteFor = (name) => config.services.find((s) => s.name === name)?.note
  const jsonLogFor = (name) => config.services.find((s) => s.name === name)?.jsonLog
  const tabNames = ['run-local', ...config.services.filter((s) => engine.included(s.name)).map((s) => s.name)]
  const screen = blessed.screen({ smartCSR: true, title: BRAND, fullUnicode: true })

  const brandLabel = ` ${BRAND} `
  const brand = blessed.box({
    top: 0, left: 0, width: brandLabel.length, height: 1, tags: true,
    content: `{bold}{cyan-fg}${brandLabel}{/cyan-fg}{/bold}`,
  })
  const tabBar = blessed.box({ top: 0, left: brandLabel.length, width: `100%-${brandLabel.length}`, height: 1, tags: true })
  const statusBar = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 1, tags: true,
    style: { bg: 'blue', fg: 'white' },
  })

  // Each tab is a bordered outer box (border + label live here) containing:
  // an optional pinned header (service's `note` — e.g. a URL — for a normal
  // tab, or the permanent gradient logo for the pipeline/run-local tab; both
  // don't scroll away like a logged line would) and the scrollable log itself
  // underneath. blessed auto-offsets a child's top/left to start inside a
  // bordered parent's border (top:0 here means "first row inside the
  // border"), but it does NOT shrink a child's own width:'100%'/height:'100%'
  // to account for that border — '100%' resolves to the parent's full outer
  // size, so an unadjusted child overflows exactly 1 column right / 1 row
  // down, silently overwriting the parent's own right and bottom border.
  // Every child of `outer` below subtracts 2 (one border width per side)
  // from both width and height to actually fit inside it.
  const logs = {}
  tabNames.forEach((name, i) => {
    const note = noteFor(name)
    const isPipeline = name === 'run-local'
    const headerRows = note ? 1 : isPipeline ? LOGO_HEIGHT : 0
    const outer = blessed.box({
      label: ` ${displayName(name)} `,
      top: 1, left: 0, width: '100%', height: '100%-2',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: name === 'run-local' ? 'cyan' : 'grey' }, label: { bold: true } },
      hidden: i !== 0,
    })
    if (note) {
      blessed.box({
        parent: outer,
        top: 0, left: 0, width: '100%-2', height: 1,
        tags: true,
        content: `{grey-fg}${note}{/grey-fg}`,
      })
    } else if (isPipeline) {
      blessed.box({
        parent: outer,
        top: 0, left: 0, width: '100%-2', height: LOGO_HEIGHT,
        tags: true,
        content: LOGO,
      })
    }
    const jsonLog = jsonLogFor(name)
    const log = blessed.log({
      parent: outer,
      top: headerRows, left: 0, width: '100%-2', height: headerRows ? `100%-${2 + headerRows}` : '100%-2',
      // Tags are only turned on for a service configured with `jsonLog` (so
      // its formatted/colored lines render) — everywhere else stays raw text
      // so stray `{`/`}` in normal output (stack traces, JSON-ish strings)
      // can't be misread as a blessed tag.
      tags: !!jsonLog, mouse: true, scrollable: true, alwaysScroll: true,
      scrollbar: { ch: '│', style: { fg: 'cyan' } },
    })
    logs[name] = { box: outer, log, jsonLog }
    screen.append(outer)
  })
  screen.append(brand)
  screen.append(tabBar)
  screen.append(statusBar)

  // The "run-local" tab has no status of its own (it's just this script's own
  // setup/shortcut output) — give it a fixed neutral color instead of a glyph.
  const tabState = (name) => (name === 'run-local' ? { color: 'cyan', glyph: '' } : (() => {
    const st = engine.status.get(name) || 'starting'
    return { color: STATE_COLOR(st), glyph: `${STATE_GLYPH(st)} ` }
  })())

  let active = 0
  const redrawTabs = () => {
    tabBar.setContent(tabNames.map((n, i) => {
      const { color, glyph } = tabState(n)
      const label = ` ${glyph}${displayName(n)} `
      const entry = logs[n]
      if (entry) entry.box.style.border.fg = color // ties each tab's own border color to its live status
      // Active tab is a solid block in its OWN status color (not a fixed
      // highlight color) so you can still see e.g. yellow-while-building even
      // while sitting on that exact tab watching it build.
      return i === active
        ? `{${color}-bg}{black-fg}{bold}${label}{/bold}{/black-fg}{/${color}-bg}`
        : `{${color}-fg}${label}{/${color}-fg}`
    }).join(''))
    screen.render()
  }
  const showTab = (i) => {
    active = ((i % tabNames.length) + tabNames.length) % tabNames.length
    tabNames.forEach((n, j) => { logs[n].box.hidden = j !== active })
    redrawTabs()
  }
  const shortcuts = config.shortcuts || []
  const legend = `{bold}q{/bold} quit  {bold}Tab{/bold}/←→ switch  {bold}↑↓{/bold} scroll  ${shortcuts.map((s) => `{bold}${s.key}{/bold} ${s.label}`).join('  ')}`
  statusBar.setContent(` ${legend} `) // static — shortcuts don't change at runtime, no need to redraw this each tick
  const redrawStatus = () => {
    redrawTabs() // status can change without a tab switch — keep glyphs/borders live (renders internally)
  }

  showTab(0)
  redrawStatus()
  const interval = setInterval(redrawStatus, 1000)

  screen.key(['tab', 'right'], () => showTab(active + 1))
  screen.key(['S-tab', 'left'], () => showTab(active - 1))
  tabNames.forEach((_, i) => { if (i < 9) screen.key([String(i + 1)], () => showTab(i)) })
  screen.key(['q', 'C-c'], () => onQuit())

  // Keyboard scrolling for whichever tab is currently active — bound at the
  // screen level (like tab switching above) rather than via blessed's
  // per-widget `keys`/`vi` options, which would require focusing the log
  // widget AND would bind j/k/g/G/ctrl+u/d/b/f, any of which a project's own
  // shortcuts[] could legitimately reuse as its `key`. Mouse wheel already
  // works independently of this (blessed's own `mouse: true` handling).
  const activeLog = () => logs[tabNames[active]].log
  screen.key(['up'], () => { activeLog().scroll(-1); screen.render() })
  screen.key(['down'], () => { activeLog().scroll(1); screen.render() })
  screen.key(['pageup'], () => { const l = activeLog(); l.scroll(-(l.height || 1)); screen.render() })
  screen.key(['pagedown'], () => { const l = activeLog(); l.scroll(l.height || 1); screen.render() })
  screen.key(['home'], () => { activeLog().scrollTo(0); screen.render() })
  screen.key(['end'], () => { activeLog().setScrollPerc(100); screen.render() })

  for (const shortcut of shortcuts) screen.key([shortcut.key], () => engine.runShortcut(shortcut))

  return {
    write(tab, line) {
      const target = logs[tab] ? tab : 'run-local'
      const entry = logs[target]
      let content = line
      if (entry.jsonLog) {
        // Only a line that actually parses as a single JSON object gets
        // reformatted — anything else (build tool banners, stack traces,
        // partial output) still needs escaping since this tab's widget is in
        // tags:true mode, but is otherwise shown unchanged.
        content = formatJsonLogLine(line, entry.jsonLog) ?? escapeTags(line)
      }
      entry.log.log(content)
      screen.render()
    },
    refreshStatus: redrawStatus,
    destroy() { clearInterval(interval); screen.destroy() },
  }
}

module.exports = { createUI }
