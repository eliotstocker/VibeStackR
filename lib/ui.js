'use strict'

const blessed = require('blessed')
const { STATE_COLOR, STATE_GLYPH } = require('./engine')
const { formatJsonLogLine, escapeTags } = require('./json-log')
const { LOGO, LOGO_HEIGHT, gradientSegments } = require('./logo')

// One tab per service (+ a "run-local" tab for setup/shortcut output) and a
// status bar, all in THIS process — no child process, no fifo, no log-file
// tailing; it just renders the lines this process already has in memory.
// This is a dev-only interactive tool so there's no non-TTY fallback — pipe/
// CI usage isn't a supported mode.
function createUI({ config, engine, onQuit, onDetach, onReloadConfig, version }) {
  // "run-local" is the internal key/tab for this script's own setup/shortcut
  // output (log()/warn()/runSync's default target) — config.name only
  // changes what's displayed for it (brand corner + tab label), not the key.
  const BRAND = config.name || 'run-local'
  const serviceFor = (name) => config.services.find((s) => s.name === name)
  const groupFor = (name) => serviceFor(name)?.group
  const displayName = (name) => {
    if (name === 'run-local') return 'VIBESTACKR'
    const group = groupFor(name)
    if (!group) return name
    const shortName = name.startsWith(group + '/') ? name.slice(group.length + 1) : name
    return `${group} ┆ ${shortName}`
  }
  const noteFor = (name) => serviceFor(name)?.note
  const jsonLogFor = (name) => serviceFor(name)?.jsonLog
  const tabNames = ['run-local', ...config.services.filter((s) => engine.included(s.name)).map((s) => s.name)]
  const screen = blessed.screen({ smartCSR: true, title: BRAND, fullUnicode: true })
  // blessed's own enableMouse() (triggered lazily the first time any widget
  // below registers a mouse/click/wheel listener) picks its encoding purely
  // from TERM: any `xterm*` TERM — which is what most modern terminal apps
  // report, including Hyper — gets the legacy UTF8 mouse mode (1005), not SGR
  // (1006). Terminals like Hyper/iTerm2/Kitty only understand SGR, so those
  // reports never arrive and clicks/wheel silently do nothing. Forcing SGR
  // here (blessed's parser auto-detects the reply format either way) fixes
  // that without touching TERM detection itself.
  screen.program.setMouse({ sgrMouse: true }, true)

  const brandLabel = ` ${BRAND} `
  const brand = blessed.box({
    top: 0, left: 0, width: brandLabel.length, height: 1, tags: true,
    content: `{bold}{cyan-fg}${brandLabel}{/cyan-fg}{/bold}`,
  })
  const versionLabel = version ? ` VibeStackR v${version} ` : ''
  const versionBox = blessed.box({
    top: 0, right: 0, width: versionLabel.length, height: 1, tags: true,
    content: gradientSegments([{ text: versionLabel, bold: true }]),
  })
  // Tabs live on their own single row (below the brand) as individual
  // clickable boxes rather than one plain text line — each tab's background
  // is its own live status color (so state reads at a glance), with the
  // active tab distinguished by a darker shade of that same color plus bold
  // text (no border — see the no-border note further down for why one isn't
  // used here). The bar stays one row tall and instead scrolls horizontally
  // once there are enough services/long enough names to exceed the terminal
  // width (see layoutTabs()/scrollTabsToActive() below) — clipped by blessed
  // to tabBar's own bounds, same as any other overflowing child.
  const TAB_ROW_HEIGHT = 1
  const tabBar = blessed.box({ top: 1, left: 0, width: '100%', height: TAB_ROW_HEIGHT })
  // No style.bg — the counts/legend text itself is the same pink-to-orange
  // gradient as the logo (gradientSegments() in redrawStatus() below), on
  // the terminal's own default background rather than a filled bar.
  const statusBar = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 1, tags: true,
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
      top: 1 + TAB_ROW_HEIGHT, left: 0, width: '100%', height: `100%-${2 + TAB_ROW_HEIGHT}`, // 1-row statusBar baseline — redrawStatus()'s applyStatusBarHeight() keeps this in sync once statusBar actually wraps to more
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
    // ScrollableBox's own constructor (which `scrollable: true` above pulls
    // in — see the next comment) wires wheeldown/wheelup to scroll half the
    // box's *height* per notch, which on a tall panel is a lot of lines for
    // one flick of a wheel. Replace with a fixed, small per-notch amount.
    log.removeAllListeners('wheeldown')
    log.removeAllListeners('wheelup')
    log.on('wheeldown', () => { log.scroll(2); screen.render() })
    log.on('wheelup', () => { log.scroll(-2); screen.render() })
    // blessed's own `scrollable: true` implementation copies ScrollableBox's
    // methods directly onto the instance (an internal "workaround to get a
    // `scrollable` option", see element.js) — that shadows Log's own scroll()
    // override (the one that tracks "has the user scrolled away from the
    // tail?" and skips the auto-scroll-to-bottom on new content). Net effect:
    // any scroll — mouse wheel here, or our own ↑/↓/PgUp/PgDn key handlers
    // below — gets silently discarded the moment the next line arrives,
    // snapping straight back to the bottom. `pinned` re-implements that
    // tracking ourselves via the 'scroll' event (which the shadowed method
    // still emits), so `write()` below can restore the user's position after
    // blessed's own forced scroll-to-bottom runs.
    const isAtBottom = () => {
      if (!log._clines || !log.height || outer.hidden) return true
      const height = log.height - (log.iheight || 0)
      if (log._clines.length <= height) return true
      const maxScroll = log._clines.length - height
      return log.getScrollPerc() >= 100 || log.childBase >= maxScroll
    }
    const entry = { box: outer, log, jsonLog, pinned: true }
    log.on('scroll', () => { entry.pinned = isAtBottom() })
    logs[name] = entry
    screen.append(outer)
  })
  screen.append(brand)
  if (version) screen.append(versionBox)
  screen.append(tabBar)
  screen.append(statusBar)

  // The "run-local" tab has no status of its own (it's just this script's own
  // setup/shortcut output) — give it a fixed neutral color instead of a glyph.
  const tabState = (name) => (name === 'run-local' ? { color: 'cyan', glyph: '' } : (() => {
    const st = engine.status.get(name) || 'starting'
    return { color: STATE_COLOR(st), glyph: `${STATE_GLYPH(st)} ` }
  })())

  // Each tab is its own bordered, clickable box (not one plain text line) so
  // it visually reads as a tab and can be clicked directly, in addition to
  // Tab/←→/number-key switching. Glyph width never changes for a given tab
  // (STATE_GLYPH is always exactly one character, and run-local's glyph is
  // permanently empty) so each box's width is fixed at creation time.
  //
  // run-local (tabNames[0]) is pinned directly in tabBar, always at left:0,
  // and never scrolls — it's this script's own output, always the most
  // useful tab to jump back to, so it should never be able to scroll out of
  // view. Every other tab lives inside `tabScroll`, a child box starting
  // just to its right and spanning the rest of the bar's width; blessed
  // clips a child's rendering to its parent's own bounds, so any of THOSE
  // tabs positioned outside tabScroll (via scrollOffset below) are simply
  // clipped there, never able to slide under/over the pinned tab.
  const pinnedLabel = `  ${tabState(tabNames[0]).glyph}${displayName(tabNames[0])}  `
  const pinnedWidth = pinnedLabel.length
  const pinnedBox = blessed.box({
    parent: tabBar,
    top: 0, left: 0, width: pinnedWidth, height: TAB_ROW_HEIGHT,
    valign: 'middle',
    tags: true,
    // No border: this blessed version's itop/ibottom (element.js) always
    // reserve 1 row top + 1 bottom whenever `border` is set at all — the
    // per-side border.top/border.bottom flags are dead code (commented out
    // there), so a `{top:false,bottom:false}` border still ate 2 of this
    // box's 1 total row, leaving none for the text. Tabs sit side-by-side with
    // no gap; each tab's left accent border is its divider.
    mouse: true,
    content: pinnedLabel,
  })
  pinnedBox.on('click', () => showTab(0))
  // Each tab box is itself `mouse:true` and sits directly on top of
  // tabScroll at the same coordinates — blessed routes a mouse event to
  // whichever clickable element is highest z-order at that point and stops
  // there (see Screen.prototype._listenMouse), so wheel events over an
  // actual tab never reached tabScroll's own wheeldown/wheelup handlers
  // (added below) — only the 1-column gaps between tabs did. Forwarding
  // from here too is what actually makes the wheel usable.
  pinnedBox.on('wheeldown', () => scrollTabsBy(4))
  pinnedBox.on('wheelup', () => scrollTabsBy(-4))

  // `scrollable: true` isn't for scrolling here (we manage the scrollBoxes'
  // left ourselves) — it's the only thing that makes blessed clip a child to
  // its parent's bounds at all (see element.js's `_getCoords`: an element
  // only gets clipped if it finds a *scrollable* ancestor while walking up;
  // a plain box lets children with left < 0 paint straight over whatever's
  // behind them, which is exactly what let a scrolled-left tab render on top
  // of the pinned run-local tab instead of disappearing at tabScroll's edge).
  const tabScroll = blessed.box({ parent: tabBar, top: 0, left: pinnedWidth, width: `100%-${pinnedWidth}`, height: TAB_ROW_HEIGHT, scrollable: true, mouse: true })

  // naturalLeft is each scrollable tab's un-scrolled position within
  // tabScroll (fixed once, widths never change) — box.left below is always
  // naturalLeft - scrollOffset, so scrolling is just shifting every one of
  // these tabs by the same amount rather than recomputing positions.
  let scrollWidth = 0
  const scrollBoxes = tabNames.slice(1).map((n, si) => {
    const i = si + 1
    const label = `  ${tabState(n).glyph}${displayName(n)}  `
    const box = blessed.box({
      parent: tabScroll,
      top: 0, left: scrollWidth, width: label.length, height: TAB_ROW_HEIGHT,
      valign: 'middle',
      tags: true,
      mouse: true,
      content: label,
    })
    box.naturalLeft = scrollWidth
    scrollWidth += label.length
    box.on('click', () => showTab(i))
    box.on('wheeldown', () => scrollTabsBy(4))
    box.on('wheelup', () => scrollTabsBy(-4))
    return box
  })
  const tabBoxes = [pinnedBox, ...scrollBoxes] // indexed the same as tabNames, for redrawTabs()/showTab() below

  // Once the scrollable tabs are wider than tabScroll's own width, shift them
  // all left/right by the same scrollOffset (clipped at tabScroll's edges by
  // blessed, same as any other overflowing child) to keep the active tab in
  // view — recomputed on resize (available width can change) and after every
  // showTab() (active tab changes). Selecting run-local itself (index 0,
  // always pinned already) leaves scrollOffset untouched.
  let scrollOffset = 0
  function applyTabScroll() {
    redrawTabs()
  }
  function scrollTabsToActive() {
    if (active === 0) return
    const box = scrollBoxes[active - 1]
    const visibleWidth = tabScroll.width
    const maxScroll = Math.max(0, scrollWidth - visibleWidth)
    if (box.naturalLeft - scrollOffset < 0) scrollOffset = box.naturalLeft
    else if (box.naturalLeft + box.width - scrollOffset > visibleWidth) scrollOffset = box.naturalLeft + box.width - visibleWidth
    scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll))
    applyTabScroll()
  }
  // Manual scroll of the tab row itself — independent of switching tabs
  // (scrollTabsToActive above only ever moves it to keep the ACTIVE tab in
  // view). Lets a tab further along the bar be peeked at/clicked without
  // first cycling through every tab in between via Tab/arrows.
  function scrollTabsBy(delta) {
    const visibleWidth = tabScroll.width
    const maxScroll = Math.max(0, scrollWidth - visibleWidth)
    scrollOffset = Math.max(0, Math.min(scrollOffset + delta, maxScroll))
    applyTabScroll()
  }
  tabScroll.on('wheeldown', () => scrollTabsBy(4))
  tabScroll.on('wheelup', () => scrollTabsBy(-4))
  screen.key(['S-right'], () => { if (!modalOpen()) scrollTabsBy(4) })
  screen.key(['S-left'], () => { if (!modalOpen()) scrollTabsBy(-4) })

  let active = 0
  const redrawTabs = () => {
    const visibleWidth = tabScroll.width
    tabNames.forEach((n, i) => {
      const { color, glyph } = tabState(n)
      const box = tabBoxes[i]
      const isActive = i === active
      const label = `${glyph}${displayName(n)}`
      // Active tab has a solid left block border (▌) on status background;
      // inactive tabs have a thin vertical accent line border (│) on black background.
      const rawContent = isActive ? `▌ ${label}  ` : `│ ${label}  `

      box.style.bg = isActive ? color : 'black'
      box.style.fg = isActive ? 'black' : color
      box.style.bold = isActive
      box.style.underline = isActive

      const entry = logs[n]
      if (entry) entry.box.style.border.fg = color // ties each tab's own content-panel border color to its live status

      if (i === 0) {
        box.setContent(isActive ? `{bold}${rawContent}{/bold}` : rawContent)
        return
      }

      // Scrollable tabs in tabScroll: when sliding off the left side (rawLeft < 0),
      // slice the left characters off rawContent so the visible right portion
      // (e.g. "ostgres") is displayed flush at the left boundary of tabScroll.
      const rawLeft = box.naturalLeft - scrollOffset
      if (rawLeft < 0) {
        const offset = -rawLeft
        if (offset >= rawContent.length) {
          box.hidden = true
        } else {
          box.hidden = false
          box.left = 0
          box.width = rawContent.length - offset
          const sliced = rawContent.slice(offset)
          box.setContent(isActive ? `{bold}${sliced}{/bold}` : sliced)
        }
      } else {
        box.left = rawLeft
        box.width = rawContent.length
        box.hidden = rawLeft >= visibleWidth
        box.setContent(isActive ? `{bold}${rawContent}{/bold}` : rawContent)
      }
    })
    screen.render()
  }
  const showTab = (i) => {
    active = ((i % tabNames.length) + tabNames.length) % tabNames.length
    tabNames.forEach((n, j) => { logs[n].box.hidden = j !== active })
    // The job pane is a sibling box (not a child of the service's own outer
    // box), so it doesn't automatically hide/show along with it — only
    // relevant while its own service's tab is the active one.
    jobPanes.forEach((p) => { p.box.hidden = tabNames[active] !== p.serviceName })
    scrollTabsToActive()
    redrawTabs()
    const activeName = tabNames[active]
    const entry = logs[activeName]
    if (entry && entry.pinned) {
      entry.log.setScrollPerc(100)
      screen.render()
    }
  }
  const shortcuts = config.shortcuts || []
  // 'b' backgrounds: closes this TUI only, leaving the daemon (a separate,
  // already-detached process — see bin/vibestackr) running untouched. 'q'
  // stays "stop everything" — deliberately NOT the same action, so muscle
  // memory on 'q' can't accidentally take down a long-running background
  // stack.
  // Same pink-to-orange gradient as the VIBESTACKR logo, run across the whole
  // legend as one continuous strip (gradientSegments takes care of that —
  // see lib/logo.js) rather than each segment restarting its own gradient.
  const legendStaticSegments = [
    { text: ' ' }, { text: 'q', bold: true }, { text: ':quit ' },
    ...(onDetach ? [{ text: 'b', bold: true }, { text: ':bg ' }] : []),
    ...(onReloadConfig ? [{ text: 'R', bold: true }, { text: ':reload ' }] : []),
    { text: 'S', bold: true }, { text: ':restart ' },
    { text: 'J', bold: true }, { text: ':jobs ' },
    { text: 'Tab', bold: true }, { text: ':switch ' },
    { text: '↑↓', bold: true }, { text: ':scroll ' },
    { text: 'O', bold: true }, { text: ':more ' },
  ]
  const SHORTCUT_LABEL_MAX = 50
  const truncateLabel = (label) => label.length > SHORTCUT_LABEL_MAX ? label.slice(0, SHORTCUT_LABEL_MAX) + '…' : label
  // Collapsed: just the keys (e.g. `r / s / p / g`) — enough to see what's
  // bound without the labels eating the one-row legend. Expanded: full
  // key+label pairs, each label capped at SHORTCUT_LABEL_MAX so one very
  // long shortcut name can't blow out the whole expanded view.
  const shortcutKeysCompact = shortcuts.length
    ? [{ text: ' ' }, { text: shortcuts.map((s) => s.key).join(' / ') }, { text: ' ' }]
    : []
  const shortcutFullSegments = shortcuts.flatMap((s) => [{ text: s.key, bold: true }, { text: ` ${truncateLabel(s.label)}  ` }])
  // Overall up/pending/down counts, same green/yellow/red convention as each
  // tab's own status color (STATE_COLOR) — 'run-local' has no status of its
  // own (see tabState() above) so it's excluded here too, same reasoning.
  function countStatuses() {
    let up = 0
    let pending = 0
    let down = 0
    for (const st of engine.status.values()) {
      const color = STATE_COLOR(st)
      if (color === 'green') up++
      else if (color === 'red') down++
      else pending++
    }
    return { up, pending, down }
  }

  // The status bar is anchored to the screen's bottom edge (bottom:0) and
  // grows UPWARD as its row count increases (word-wrap, from blessed's own
  // `wrap` default) rather than overflowing off-screen — but each content
  // panel's own height is computed relative to the *fixed* top offset below
  // the tab bar (see `outer` above), with no way to know statusBar's current
  // height on its own. Whenever that row count changes, every panel's height
  // needs recalculating too, so its bottom edge still lands exactly at
  // statusBar's (now possibly taller) top edge instead of running under it.
  let statusBarRows = 1
  function applyStatusBarHeight(rows) {
    if (rows === statusBarRows) return
    statusBarRows = rows
    statusBar.height = rows
    for (const name of tabNames) {
      logs[name].box.height = `100%-${1 + TAB_ROW_HEIGHT + statusBarRows}`
    }
  }

  // Collapsed (the default) truncates to exactly one row rather than letting
  // it wrap/grow — 'O' (see legendSegments above) expands to the full
  // wrapped view until the next keypress/click of ANY kind collapses it
  // back (see the screen-level listeners below). Truncates by TEXT length
  // across segments, before gradientSegments ever runs, so the gradient
  // itself is recomputed over the shorter total rather than getting cut off
  // mid-tag.
  let expanded = false
  function truncateSegments(segments, maxLen) {
    const totalLen = segments.reduce((n, s) => n + s.text.length, 0)
    if (totalLen <= maxLen) return segments
    let budget = Math.max(0, maxLen - 1) // -1 reserves room for the trailing ellipsis marker
    const out = []
    for (const seg of segments) {
      if (budget <= 0) break
      if (seg.text.length <= budget) { out.push(seg); budget -= seg.text.length }
      else { out.push({ ...seg, text: seg.text.slice(0, budget) }); budget = 0 }
    }
    out.push({ text: '…' })
    return out
  }

  const redrawStatus = () => {
    redrawTabs() // status can change without a tab switch — keep glyphs/borders live (renders internally)
    const { up, pending, down } = countStatuses()
    // Counts are rebuilt fresh each tick (the numbers change); legendSegments
    // itself is static (shortcuts don't change at runtime — a config reload
    // rebuilds this whole UI from scratch, see bin/vibestackr, rather than
    // patching shortcuts in place) but still passed through gradientSegments
    // every time so its gradient positions stay continuous with the counts
    // in front of it, rather than restarting its own gradient. Only the
    // NUMBER in each count keeps a fixed status color (fg override) — the
    // "up"/"pending"/"down" words take the shared gradient like everything
    // else — just bold, same gradient color as everything around it, no
    // separate green/yellow/red (tried that, looked worse against the
    // gradient than just letting the gradient carry through).
    const countSegments = [
      { text: ' ' }, { text: `${up}`, bold: true }, { text: ' up ' },
      { text: `${pending}`, bold: true }, { text: ' pending ' },
      { text: `${down}`, bold: true }, { text: ' down ' },
    ]
    const legendSegments = [
      ...legendStaticSegments,
      ...(expanded ? shortcutFullSegments : shortcutKeysCompact),
    ]
    const allSegments = [...countSegments, { text: '| ' }, ...legendSegments]
    const shown = expanded ? allSegments : truncateSegments(allSegments, statusBar.width)
    statusBar.setContent(gradientSegments(shown))
    // _clines is populated synchronously by setContent() above (see
    // element.js) — reading it straight after is blessed's own actual
    // word-wrap result, not a guess at one re-derived from screen.width here.
    applyStatusBarHeight(statusBar._clines.length)
    screen.render()
  }

  // Built-in "restart which service?" picker (Shift+S) — a bordered
  // blessed.list overlaid centered on screen, listing every included
  // service with its live status glyph/color, same convention as the tab
  // bar. Distinct from shortcuts[]'s own `restart` (which always targets one
  // fixed, pre-configured service) — this is for restarting whichever
  // service you want without a shortcut bound to it. Only one open at a
  // time; Esc (or selecting an item) closes it.
  let restartPicker = null
  function closeRestartPicker() {
    if (!restartPicker) return
    restartPicker.destroy()
    restartPicker = null
    screen.render()
  }
  function openRestartPicker() {
    if (restartPicker) return
    const names = tabNames.slice(1) // exclude the run-local/pipeline tab — nothing to "restart" there
    if (!names.length) return
    const items = names.map((n) => {
      const st = engine.status.get(n) || 'starting'
      return `{${STATE_COLOR(st)}-fg}${STATE_GLYPH(st)}{/${STATE_COLOR(st)}-fg} ${n}`
    })
    const width = Math.min(50, Math.max(20, Math.max(...names.map((n) => n.length)) + 6))
    const height = Math.min(names.length + 2, 20)
    restartPicker = blessed.list({
      parent: screen,
      top: 'center', left: 'center', width, height,
      border: { type: 'line' },
      label: ' restart which service? (Esc to cancel) ',
      tags: true, keys: true, vi: true, mouse: true,
      items,
      style: { selected: { bg: 'cyan', fg: 'black' }, border: { fg: 'cyan' }, label: { bold: true } },
    })
    restartPicker.on('select', (_item, i) => {
      const name = names[i]
      closeRestartPicker()
      engine.restartService(name)
    })
    restartPicker.key(['escape'], () => closeRestartPicker())
    restartPicker.focus()
    screen.render()
  }
  screen.key(['S-s'], () => { if (!inputForm) openRestartPicker() })

  // Two-step service -> job picker (S-j): pick a service, then a job
  // discovered for it (npm/make/gradle/python/cargo — see
  // lib/job-discovery.js), then run it in a split pane under that service's
  // own log tab (openJobPane below). Chained blessed.lists, same convention
  // as openRestartPicker.
  let jobPicker = null
  function closeJobPicker() {
    if (!jobPicker) return
    jobPicker.destroy()
    jobPicker = null
    screen.render()
  }
  function openJobPicker(serviceName, jobs) {
    const items = jobs.map((j) => `${j.source}:${j.label}`)
    const width = Math.min(50, Math.max(24, Math.max(...items.map((n) => n.length)) + 6))
    const height = Math.min(jobs.length + 2, 20)
    jobPicker = blessed.list({
      parent: screen,
      top: 'center', left: 'center', width, height,
      border: { type: 'line' },
      label: ` run which job in '${serviceName}'? (Esc to cancel) `,
      tags: true, keys: true, vi: true, mouse: true,
      items,
      style: { selected: { bg: 'cyan', fg: 'black' }, border: { fg: 'cyan' }, label: { bold: true } },
    })
    jobPicker.on('select', async (_item, i) => {
      const job = jobs[i]
      closeJobPicker()
      try {
        const tab = await engine.runJob(serviceName, job.id)
        openJobPane(serviceName, job, tab)
      } catch (err) {
        write('run-local', `[run-local] WARNING: failed to run job '${job.id}': ${err.message}`)
      }
    })
    jobPicker.key(['escape'], () => closeJobPicker())
    jobPicker.focus()
    screen.render()
  }
  async function openJobServicePicker() {
    if (jobPicker || restartPicker || inputForm) return
    // Only offer services that actually have something discoverable —
    // one round-trip (discoverAllJobs) rather than per-service, and the
    // per-service job list is reused directly on select instead of
    // re-fetching it.
    let allJobs
    try { allJobs = await engine.discoverAllJobs() } catch (err) { write('run-local', `[run-local] WARNING: job discovery failed: ${err.message}`); return }
    if (jobPicker || restartPicker || inputForm) return // state may have changed while awaiting
    const entries = allJobs.filter((s) => s.jobs.length)
    if (!entries.length) { write('run-local', '[run-local] no discoverable jobs for any service'); return }
    const names = entries.map((e) => e.name)
    const width = Math.min(50, Math.max(20, Math.max(...names.map((n) => n.length)) + 6))
    const height = Math.min(names.length + 2, 20)
    jobPicker = blessed.list({
      parent: screen,
      top: 'center', left: 'center', width, height,
      border: { type: 'line' },
      label: ' run a job in which service? (Esc to cancel) ',
      tags: true, keys: true, vi: true, mouse: true,
      items: names,
      style: { selected: { bg: 'cyan', fg: 'black' }, border: { fg: 'cyan' }, label: { bold: true } },
    })
    jobPicker.on('select', (_item, i) => {
      const { name: serviceName, jobs } = entries[i]
      closeJobPicker()
      openJobPicker(serviceName, jobs)
    })
    jobPicker.key(['escape'], () => closeJobPicker())
    jobPicker.focus()
    screen.render()
  }
  screen.key(['S-j'], () => { if (!inputForm && !restartPicker) openJobServicePicker() })

  // Split panes for running jobs' output: shrinks the target service's own
  // log box to the top half of its tab and adds a bordered box (with its own
  // log + a close button) below it, tailed via engine.watchJobTab. Several
  // panes can be open at once — keyed by tab, so a jobs[]-type shortcut can
  // open one per job. Panes belonging to the same service share the bottom
  // half of the screen, split evenly between them. Closing (button, Esc, or
  // backspace) only stops tailing (engine.unwatchJobTab) — the job itself
  // keeps running/finishing server-side regardless, same "detach doesn't
  // kill" philosophy as the daemon connection itself.
  const jobPanes = new Map() // tab -> { serviceName, tab, box, log, statusInterval }
  function panesForService(serviceName) {
    return [...jobPanes.values()].filter((p) => p.serviceName === serviceName)
  }
  function relayoutPanes(serviceName) {
    const panes = panesForService(serviceName)
    const outer = logs[serviceName].box
    if (panes.length === 0) {
      outer.height = `100%-${2 + TAB_ROW_HEIGHT}`
      return
    }
    outer.height = '50%-2' // top half — see the height-math note above openRestartPicker for why this is approximate, not pixel-exact
    const slice = 50 / panes.length
    panes.forEach((p, i) => {
      p.box.top = `${50 + i * slice}%-1`
      p.box.height = `${slice}%-1`
    })
  }
  function closeJobPane(tab) {
    const pane = jobPanes.get(tab)
    if (!pane) return
    const { serviceName, box, statusInterval } = pane
    clearInterval(statusInterval)
    box.destroy()
    jobPanes.delete(tab)
    engine.unwatchJobTab(tab)
    relayoutPanes(serviceName)
    screen.render()
  }
  function closeAllJobPanes() {
    ;[...jobPanes.keys()].forEach(closeJobPane)
  }
  function openJobPane(serviceName, job, tab) {
    closeJobPane(tab) // replace, if a pane for this exact tab is already open
    showTab(tabNames.indexOf(serviceName)) // jump to the service the job is running in, so its output is visible right away
    const box = blessed.box({
      parent: screen,
      top: '50%-1', left: 0, width: '100%', height: '50%-1',
      label: ` ${serviceName}: ${job.source}:${job.label} — running `,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' }, label: { bold: true } },
    })
    const log = blessed.log({
      parent: box,
      top: 0, left: 0, width: '100%-2', height: '100%-2',
      mouse: true, scrollable: true, alwaysScroll: true,
      scrollbar: { ch: '│', style: { fg: 'cyan' } },
    })
    // Same per-notch wheel amount as every other tab's log (see the
    // `outer` log setup above for why the ScrollableBox default is overridden).
    log.removeAllListeners('wheeldown')
    log.removeAllListeners('wheelup')
    log.on('wheeldown', () => { log.scroll(2); screen.render() })
    log.on('wheelup', () => { log.scroll(-2); screen.render() })
    const closeButton = blessed.button({
      parent: box,
      top: -1, right: 1, width: 9, height: 1,
      mouse: true, align: 'center', content: 'Close',
      style: { bg: 'red', fg: 'black', focus: { bg: 'light-red' }, hover: { bg: 'light-red' } },
    })
    closeButton.on('press', () => closeJobPane(tab))
    const pane = { serviceName, tab, box, log, statusInterval: null }
    jobPanes.set(tab, pane)
    relayoutPanes(serviceName)
    pane.statusInterval = setInterval(() => {
      const status = engine.jobStatus.get(tab)
      if (status && status !== 'running') {
        box.setLabel(` ${serviceName}: ${job.source}:${job.label} — ${status} `)
        box.style.border.fg = status === 'succeeded' ? 'green' : 'red'
        clearInterval(pane.statusInterval) // status is terminal, stop polling
      }
      screen.render()
    }, 500)
    engine.watchJobTab(tab)
    screen.render()
  }
  screen.key(['escape'], () => { if (jobPanes.size && !modalOpen()) closeAllJobPanes() })

  // Popover for an interactive shortcut (shortcuts[].inputs) — one text box
  // per declared input, stacked in a single blessed.form. Enter on a box
  // moves to the next (or submits the form, on the last one); Esc cancels
  // via the textbox's own built-in 'cancel' event, same as blessed's usual
  // input-editing convention, rather than a key binding of our own (a
  // focused/"reading" textbox grabs all keys itself — see blessed's Textbox
  // widget — so a plain screen/form-level key() binding wouldn't fire while
  // typing anyway).
  let inputForm = null
  const modalOpen = () => !!restartPicker || !!inputForm || !!jobPicker
  // Ends whatever box is currently mid-readInput() (if any) through the
  // normal Escape-key path rather than leaving it to a 'blur' — see
  // focusInputBox below for why. `synthetic: true` on the key object marks
  // this as internal bookkeeping (not a real user keypress) so a box's own
  // `box.key(['escape'], ...)` close-the-form handler can tell the
  // difference and not treat every safety-escape as "the user hit Escape".
  function endCurrentReading() {
    if (screen.focused && screen.focused._reading) screen.focused.emit('keypress', '\x1b', { name: 'escape', synthetic: true })
  }
  function closeInputForm() {
    if (!inputForm) return
    const form = inputForm
    inputForm = null
    endCurrentReading()
    form.destroy()
    screen.render()
  }
  function openShortcutInputForm(shortcut) {
    if (inputForm || restartPicker) return
    const inputs = shortcut.inputs
    const ROW_HEIGHT = 3
    const BUTTON_ROW_HEIGHT = 2
    const width = 54
    const height = inputs.length * ROW_HEIGHT + BUTTON_ROW_HEIGHT + 2
    const form = blessed.form({
      parent: screen,
      top: 'center', left: 'center', width, height,
      border: { type: 'line' },
      label: ` ${shortcut.label} — Enter/Run to run, Esc/Cancel to close `,
      tags: true,
      style: { border: { fg: 'cyan' }, label: { bold: true } },
    })
    // Cleanly switches focus TO `target` — used by every click handler
    // below instead of a bare `target.focus()`. blessed's own Textarea
    // (what Textbox is built on) ends its reading session via a 'blur'
    // listener as well as the normal Enter/Escape path (see readInput() in
    // node_modules/blessed/lib/widgets/textarea.js), and that blur-driven
    // cleanup calls screen.rewindFocus() when `inputOnFocus` is set. Calling
    // target.focus() directly while another inputOnFocus box is still
    // reading fires that rewindFocus() *during* target's own focusPush (blur
    // fires synchronously inside Screen._focus, before the new focus has
    // even been fully applied) — rewindFocus() ends up popping target right
    // back off the focus history it was just pushed onto, undoing the click
    // in the same tick. blessed's own Form widget hits this exact problem
    // for Tab-based navigation between fields and works around it the same
    // way this does: feed the currently-reading box a synthetic Escape
    // keypress first, so it ends its own session through the normal
    // Escape-key path (not blur) before the new box is focused at all.
    function focusInputBox(target) {
      if (screen.focused === target) return
      endCurrentReading()
      target.focus()
    }
    const boxes = inputs.map((input, i) => {
      blessed.text({
        parent: form,
        top: i * ROW_HEIGHT, left: 1, width: width - 4, height: 1,
        content: input.label || input.name,
      })
      const box = blessed.textbox({
        parent: form,
        name: input.name,
        top: i * ROW_HEIGHT + 1, left: 1, width: width - 4, height: 1,
        inputOnFocus: true, mouse: true, clickable: true,
        value: input.default || '',
        // Distinct focus style — otherwise a focused vs. unfocused box are
        // visually identical, which makes it impossible to tell whether a
        // click actually focused anything at all.
        style: { bg: 'blue', focus: { bg: 'cyan' } },
      })
      // A click focuses the box, same as Tab-ing to it — inputOnFocus above
      // is what actually starts reading keystrokes into it once focused.
      // Bound to both 'click' and 'mousedown' — some terminals only deliver
      // one of the two reliably depending on their mouse-reporting mode.
      box.on('click', () => focusInputBox(box))
      box.on('mousedown', () => focusInputBox(box))
      // Escape closes the form — but only a REAL Escape keypress; a
      // synthetic one (see endCurrentReading above, used to safely end this
      // box's reading session before switching focus elsewhere) must NOT
      // also close the form, or clicking a different field/button would
      // close the popover instead of just moving focus/submitting. NOT
      // wired through Textarea's own 'cancel' event either — readInput()
      // emits that for a blur too, not just Escape, which is exactly the
      // ambiguity `synthetic` here is working around.
      box.key(['escape'], (ch, key) => { if (!key || !key.synthetic) closeInputForm() })
      return box
    })
    boxes.forEach((box, i) => {
      // Textbox emits 'submit' (not just 'keypress') when Enter is pressed
      // while it's focused/reading — the last box's Enter is what actually
      // triggers form.submit() (which collects every named child's value
      // into the object form's own 'submit' event below receives).
      box.on('submit', () => (i === boxes.length - 1 ? form.submit() : focusInputBox(boxes[i + 1])))
    })
    const buttonsTop = inputs.length * ROW_HEIGHT
    const runButton = blessed.button({
      parent: form,
      top: buttonsTop, left: 1, width: 10, height: 1,
      mouse: true, align: 'center', content: 'Run',
      style: { bg: 'green', fg: 'black', focus: { bg: 'light-green' }, hover: { bg: 'light-green' } },
    })
    const cancelButton = blessed.button({
      parent: form,
      top: buttonsTop, left: 13, width: 10, height: 1,
      mouse: true, align: 'center', content: 'Cancel',
      style: { bg: 'red', fg: 'black', focus: { bg: 'light-red' }, hover: { bg: 'light-red' } },
    })
    // blessed's Button.press() (fired from its own built-in mouse 'click'
    // handling — see node_modules/blessed/lib/widgets/button.js) calls
    // `this.focus()` BEFORE it ever emits 'press', which is the exact
    // scenario focusInputBox's own comment above describes — except this
    // time it happens entirely inside blessed's own code, before our
    // 'press' listener runs at all, so calling endCurrentReading() from
    // *there* would be too late (the corruption already happened). Ending
    // the box's reading pre-emptively on 'mousedown' — which the mouse
    // sequence always delivers before the 'click'/'press'/focus() that
    // follows on mouseup — does it while the box's own listener is still
    // intact, avoiding the corrupting cascade entirely.
    for (const button of [runButton, cancelButton]) button.on('mousedown', endCurrentReading)
    runButton.on('press', () => form.submit())
    cancelButton.on('press', () => closeInputForm())
    form.on('submit', (values) => {
      closeInputForm()
      runShortcutAndMaybeOpenPane(shortcut, values)
    })
    inputForm = form
    boxes[0].focus()
    screen.render()
  }

  screen.on('resize', scrollTabsToActive) // available width can change at any time — re-clamp scrollOffset so the active tab stays in view
  screen.on('resize', redrawStatus) // width change can also change how many rows the status bar wraps to
  screen.key(['S-o'], () => { expanded = true; redrawStatus() })
  // "until any other interaction" — any OTHER key (checked by key.full, so
  // pressing 'O' itself doesn't immediately re-collapse what it just
  // expanded) or a click/wheel action collapses it back. Deliberately not
  // bound to the raw 'mouse' event, which also fires on mere mouse movement
  // in terminals that report it — that would collapse this before the user
  // ever did anything.
  screen.on('keypress', (ch, key) => { if (expanded && key?.full !== 'S-o') { expanded = false; redrawStatus() } })
  for (const action of ['click', 'wheeldown', 'wheelup']) {
    screen.on(action, () => { if (expanded) { expanded = false; redrawStatus() } })
  }
  showTab(0)
  redrawStatus()
  const interval = setInterval(redrawStatus, 1000)

  // screen.key() bindings fire on every keypress regardless of which widget
  // currently has focus (unlike a widget's own `keys:true` handling, which
  // blessed does scope to focus) — without this guard, e.g. the restart
  // picker's own up/down navigation would also switch tabs / scroll the
  // active log underneath it at the same time.
  screen.key(['tab', 'right'], () => { if (!modalOpen()) showTab(active + 1) })
  screen.key(['S-tab', 'left'], () => { if (!modalOpen()) showTab(active - 1) })
  tabNames.forEach((_, i) => { if (i < 9) screen.key([String(i + 1)], () => { if (!modalOpen()) showTab(i) }) })
  screen.key(['q', 'C-c'], () => onQuit())
  if (onDetach) screen.key(['b'], () => onDetach())
  // Mouse reporting (enabled above so wheel/click scrolling works) also
  // stops the terminal's own native click-drag text selection — the
  // terminal hands every click to us instead of highlighting text. A
  // previous app-level toggle key ('m') for this never cleanly restored
  // mouse mode and still picked up border glyphs on selection — most
  // terminal emulators already have a *terminal-side* modifier that bypasses
  // application mouse reporting for exactly this (e.g. Option-drag on
  // iTerm2/Terminal.app, Shift-drag on many Linux terminals), so that's the
  // one true way to select/copy now instead of an in-app toggle.
  // Capital 'R' (not lowercase — that's free for a project's own
  // shortcuts[]) triggers a config reload without leaving the TUI. Success
  // shows up as a log line in the run-local tab on its own (see
  // lib/attach-client.js's reloadConfig() comment) — a REJECTED promise
  // (bad edit) is the one case nothing would otherwise show, so write that
  // here directly.
  if (onReloadConfig) screen.key(['S-r'], () => { onReloadConfig().catch((err) => write('run-local', `[run-local] WARNING: reload failed: ${err.message}`)) })

  // Keyboard scrolling for whichever tab is currently active — bound at the
  // screen level (like tab switching above) rather than via blessed's
  // per-widget `keys`/`vi` options, which would require focusing the log
  // widget AND would bind j/k/g/G/ctrl+u/d/b/f, any of which a project's own
  // shortcuts[] could legitimately reuse as its `key`. Mouse wheel already
  // works independently of this (blessed's own `mouse: true` handling).
  // While exactly one job pane is open on the active tab, keyboard scrolling
  // targets its log instead of the service's own — it's the one actually
  // being watched (top half is usually just steady-state service output by
  // then). With more than one pane on the same tab, which one "wins" isn't
  // obvious, so fall back to the service's own log (each pane still scrolls
  // fine via its own mouse wheel).
  const activeLog = () => {
    const panes = panesForService(tabNames[active])
    return panes.length === 1 ? panes[0].log : logs[tabNames[active]].log
  }
  screen.key(['up'], () => { if (!modalOpen()) { activeLog().scroll(-1); screen.render() } })
  screen.key(['down'], () => { if (!modalOpen()) { activeLog().scroll(1); screen.render() } })
  screen.key(['pageup'], () => { if (!modalOpen()) { const l = activeLog(); l.scroll(-(l.height || 1)); screen.render() } })
  screen.key(['pagedown'], () => { if (!modalOpen()) { const l = activeLog(); l.scroll(l.height || 1); screen.render() } })
  screen.key(['home'], () => { if (!modalOpen()) { activeLog().scrollTo(0); screen.render() } })
  screen.key(['end'], () => { if (!modalOpen()) { activeLog().setScrollPerc(100); screen.render() } })

  // A job-type shortcut (`service`+`job` in config — see
  // schema/config.schema.json) returns a `tab` from run_shortcut (see
  // control-socket.js) the same way the picker's own run does — open the
  // same split pane for it rather than leaving its output untailed.
  function runShortcutAndMaybeOpenPane(shortcut, values) {
    Promise.resolve(engine.runShortcut(shortcut, values)).then((result) => {
      if (result && result.tab) {
        const [source, ...rest] = shortcut.job.split(':')
        openJobPane(shortcut.service, { source, label: rest.join(':') || source }, result.tab)
      } else if (result && result.tabs && result.tabs.length) {
        // Open a pane for every job — panes sharing a service split its
        // bottom half evenly (see relayoutPanes).
        shortcut.jobs.forEach(({ service, job }, i) => {
          const [source, ...rest] = job.split(':')
          openJobPane(service, { source, label: rest.join(':') || source }, result.tabs[i])
        })
      }
    }).catch((err) => write('run-local', `[run-local] WARNING: shortcut '${shortcut.key}' failed: ${err.message}`))
  }

  for (const shortcut of shortcuts) screen.key([shortcut.key], () => {
    if (modalOpen()) return
    if (shortcut.inputs && shortcut.inputs.length) openShortcutInputForm(shortcut)
    else runShortcutAndMaybeOpenPane(shortcut)
  })

  function write(tab, line) {
    const pane = jobPanes.get(tab)
    if (pane) {
      pane.log.log(line)
      screen.render()
      return
    }
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
    // See the `pinned` comment above: capture position before writing and,
    // if the user had scrolled away from the tail, restore it once
    // blessed's own (buggy, always-fires) forced scroll-to-bottom has run —
    // scheduled via setImmediate so ours lands right after blessed's own
    // (both use the same nextTick/setImmediate primitive internally).
    // Restored via the absolute line offset (getScroll()/scrollTo()), not
    // getScrollPerc()/setScrollPerc() — blessed's own setScrollPerc scales
    // by total line count while getScrollPerc scales by the scrollable
    // *range* (total minus visible height), so a get→set round-trip drifts
    // toward the bottom every time a new line grows that total, exactly
    // while a live-streaming service is the reason you'd be scrolled up.
    const wasPinned = entry.pinned
    const savedOffset = entry.log.getScroll()
    entry.log.log(content)
    if (!wasPinned) {
      setImmediate(() => { entry.log.scrollTo(savedOffset); screen.render() })
    }
    screen.render()
  }

  // Overlay shown while bin/vibestackr's poll loop can't reach the daemon
  // (quit, crash, or just a hiccup) — always on top (last-appended), doesn't
  // block tab switching/scrolling like the pickers above since there's
  // nothing modal to protect here, just a status the caller
  // (bin/vibestackr) updates every second with the countdown-to-quit it
  // owns.
  let disconnectBox = null
  function showDisconnected(secondsLeft) {
    const content = `{bold}{red-fg}Lost connection to the vibestackr daemon.{/red-fg}{/bold}\n\nWaiting for it to come back — quitting in ${secondsLeft}s if it doesn't.`
    if (!disconnectBox) {
      disconnectBox = blessed.box({
        parent: screen,
        top: 'center', left: 'center', width: 54, height: 6,
        border: { type: 'line' },
        tags: true, align: 'center', valign: 'middle',
        style: { border: { fg: 'red' } },
      })
    }
    disconnectBox.setContent(content)
    screen.render()
  }
  function hideDisconnected() {
    if (!disconnectBox) return
    disconnectBox.destroy()
    disconnectBox = null
    screen.render()
  }

  return {
    write,
    refreshStatus: redrawStatus,
    showDisconnected,
    hideDisconnected,
    destroy() {
      clearInterval(interval)
      jobPanes.forEach((p) => clearInterval(p.statusInterval))
      try { screen.destroy() } catch {}
      try { process.stdin.pause() } catch {}
      try { process.stdin.unref() } catch {}
    },
  }
}

module.exports = { createUI }
