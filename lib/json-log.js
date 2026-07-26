'use strict'

// Reformats a service's structured (NDJSON) log output for display in its
// TUI tab — e.g. Spring Boot's logback JSON encoder or a Node pino logger.
// Purely a presentation concern: the raw line is always what's captured in
// the ring buffer / --persist-logs file (see lib/engine.js) — this only
// changes what gets rendered on screen. Lines that aren't a single JSON
// object are left untouched by the caller (formatJsonLogLine returns null).

// Only flags exceptions/noise by default — a normal "info" line isn't tinted
// so errors/warnings actually stand out.
const DEFAULT_LEVEL_COLORS = {
  error: 'red',
  fatal: 'red',
  severe: 'red',
  warn: 'yellow',
  warning: 'yellow',
  debug: 'grey',
  trace: 'grey',
}

function resolveField(data, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), data)
}

function stringifyValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// blessed's own tag-escaping convention (see blessed/lib/helpers.js escape())
// — reimplemented here rather than requiring blessed into this otherwise
// blessed-free module just for one regex.
function escapeTags(text) {
  return text.replace(/[{}]/g, (ch) => (ch === '{' ? '{open}' : '{close}'))
}

// `${field}` / `${field:-default}`, dot-path for nested fields (e.g.
// `${context.requestId}`). `@` is allowed in a field name for ECS-style
// fields like `@timestamp`. Every substituted VALUE is escaped individually
// before being spliced in — the template's own literal characters (config-
// authored, not runtime data) are trusted as-is.
function interpolate(format, data) {
  return format.replace(/\$\{([\w.@]+)(:-([^}]*))?\}/g, (_, path, _d, def) => {
    const value = resolveField(data, path)
    const str = value === undefined ? (def ?? '') : stringifyValue(value)
    return escapeTags(str)
  })
}

// Returns a blessed-tag-safe string ready to render, or null if `line`
// doesn't parse as a single JSON object (caller should fall back to the raw
// line in that case).
function formatJsonLogLine(line, jsonLogConfig) {
  let data
  try { data = JSON.parse(line) } catch { return null }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null

  const text = interpolate(jsonLogConfig.format, data)
  const levelField = jsonLogConfig.levelField || 'level'
  const levelValue = resolveField(data, levelField)
  if (levelValue == null) return text

  const colors = { ...DEFAULT_LEVEL_COLORS, ...(jsonLogConfig.colors || {}) }
  const color = colors[String(levelValue).toLowerCase()]
  return color ? `{${color}-fg}${text}{/${color}-fg}` : text
}

module.exports = { formatJsonLogLine, escapeTags }
