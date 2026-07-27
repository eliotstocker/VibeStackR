'use strict'

// The remote counterpart to lib/engine.js, exposing just enough of the same
// shape lib/ui.js already reads (`status`, `included()`, `runShortcut()`) for
// the TUI to render unmodified — except every value here is a snapshot
// polled off a daemon's control socket, not a live in-process object. The
// actual engine (and the services it manages) always lives in a separate,
// detached daemon process; every TUI — freshly started or reattached — is
// this attach client plus lib/ui.js, never the engine itself. See
// bin/vibestakr for how a daemon gets started/found.
//
// Callers MUST await init() before ever calling createUI() — see init()'s
// own comment below for why (in short: lib/ui.js builds its tab list once,
// at createUI() time, from included(); that must already reflect the
// daemon's real included set the very first time it's read).
//
// Deliberately polling, not push: the control socket's request/response
// protocol (lib/control-socket.js) is intentionally simple (one request, one
// response, connection closed) — same design already used by `vibestakr
// mcp`. Piggybacking a live push/subscribe channel onto it for this one
// extra consumer isn't worth the protocol complexity for a dev tool; a few
// hundred ms of latency on a new log line or status change is unnoticeable
// in practice.

const { requestSocket } = require('./control-socket')

const POLL_INTERVAL_MS = 300

function createAttachClient({ config, root, onServicesChanged }) {
  const status = new Map()
  const includedSet = new Set()
  const tailCursors = new Map() // tab name -> last-seen `total` from the 'tail' method
  const tabNames = ['run-local', ...config.services.map((s) => s.name)]

  let UI = { write: () => {}, refreshStatus() {}, destroy() {} }
  const setUI = (ui) => { UI = ui }

  const included = (name) => includedSet.has(name)

  // Populates includedSet once, from the daemon's authoritative,
  // config+args-derived included set (the 'services' method's `included`
  // field, ultimately `engine.included()`) — deliberately NOT from `status`,
  // which only gains an entry once a service's spawnService() actually runs.
  // The socket comes alive well before that (mise/checkDeps/startAll haven't
  // run yet, and a service deep in a dependsOn chain can take much longer
  // still) — using `status` here raced lib/ui.js's tab list (fixed at
  // createUI() time) against services that hadn't started yet, permanently
  // locking them out of the tab bar. `engine.included()` is available the
  // moment the engine object exists, before the control socket even binds.
  async function init() {
    const { services } = await requestSocket(root, 'services', {})
    for (const s of services) if (s.included) includedSet.add(s.name)
    includedKey = [...includedSet].sort().join(',') // baseline for checkServicesChanged() below — must reflect init()'s own result, not the empty set from before this ran
  }

  // lib/ui.js's tab list is fixed at createUI() time from included() — a
  // service added/removed via reload_config (see engine.reloadConfig()) has
  // no way to make an already-open TUI's tab bar rebuild on its own. Rather
  // than making the tab bar itself dynamic (a much bigger change touching
  // every bit of tab-scroll/layout logic in lib/ui.js), each poll re-checks
  // the daemon's included set and — only if it actually changed since last
  // observed — calls onServicesChanged() so the caller (bin/vibestakr) can
  // tear down and rebuild the whole TUI, the same fresh state a manual
  // detach+reattach would produce anyway.
  let includedKey = '' // reset for real by init() above once it has actually run
  async function checkServicesChanged() {
    if (!onServicesChanged) return
    try {
      const { services } = await requestSocket(root, 'services', {})
      const key = services.filter((s) => s.included).map((s) => s.name).sort().join(',')
      if (key !== includedKey) {
        includedKey = key
        onServicesChanged()
      }
    } catch {
      // Same as pollOnce below — a daemon hiccup here just means we check
      // again next tick, not a reason to do anything drastic.
    }
  }

  async function pollOnce() {
    try {
      const snapshot = await requestSocket(root, 'status', {})
      status.clear()
      for (const [name, state] of Object.entries(snapshot)) status.set(name, state)
      UI.refreshStatus()
    } catch {
      // Daemon hiccup or mid-restart — next tick retries. Only quit()/
      // detach() stop polling outright.
    }
    await checkServicesChanged()
    for (const name of tabNames) {
      try {
        const since = tailCursors.get(name) ?? 0
        const { lines, total } = await requestSocket(root, 'tail', { name, since })
        tailCursors.set(name, total)
        for (const line of lines) UI.write(name, line)
      } catch {
        // Same as above.
      }
    }
  }

  let timer = null
  function startPolling() {
    if (timer) return
    timer = setInterval(pollOnce, POLL_INTERVAL_MS)
  }
  function stopPolling() {
    clearInterval(timer)
    timer = null
  }

  return {
    status,
    included,
    setUI,
    init,
    pollOnce,
    startPolling,
    stopPolling,
    runShortcut: (shortcut) => requestSocket(root, 'run_shortcut', { key: shortcut.key }),
    // Success shows up on its own — the daemon's engine.reloadConfig() logs
    // "config reloaded" (or a removed-but-still-running warning) into the
    // 'run-local' tab itself, which the next pollOnce()/tail picks up same
    // as any other log line. A REJECTED promise here (bad edit — schema
    // validation failed before reloadConfig() ever ran) is the one case with
    // nothing to poll for, so the caller (bin/vibestakr) needs to surface
    // that itself.
    reloadConfig: () => requestSocket(root, 'reload_config', {}),
    // Fully stops the daemon (and every service it manages) — distinct from
    // detach() below, which only tears down this client process.
    async quit() {
      stopPolling()
      await requestSocket(root, 'quit', {}).catch(() => {})
      UI.destroy()
    },
    // Just stops polling — the daemon (already a separate, detached process)
    // is completely unaffected and keeps running.
    detach() {
      stopPolling()
      UI.destroy()
    },
  }
}

module.exports = { createAttachClient }
