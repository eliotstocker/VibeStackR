'use strict'

const fs = require('fs')
const path = require('path')

// Auto-discovers one-off jobs runnable in a service's cwd — npm scripts,
// Makefile targets, Gradle tasks, Python project scripts — independent of
// `service.type` (a node service's cwd can still have a Makefile). Called
// fresh on every request rather than cached: these are cheap file reads/
// regexes, and re-running them means an edited package.json/Makefile is
// picked up immediately, no restart needed.
//
// `id` (source-prefixed, e.g. "npm:build") is what every caller actually
// uses to run a job — bare names collide across sources often enough (a
// Makefile wrapping npm scripts, say) that this is simpler than trying to
// dedupe/mangle names instead.

function discoverNpmScripts(cwd) {
  const pkgPath = path.join(cwd, 'package.json')
  if (!fs.existsSync(pkgPath)) return []
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  return Object.keys(pkg.scripts || {}).map((name) => ({
    id: `npm:${name}`, source: 'npm', label: name, command: 'npm', args: ['run', name],
  }))
}

function discoverMakeTargets(cwd) {
  const makefilePath = ['Makefile', 'makefile'].map((f) => path.join(cwd, f)).find((p) => fs.existsSync(p))
  if (!makefilePath) return []
  const targets = []
  for (const line of fs.readFileSync(makefilePath, 'utf8').split('\n')) {
    if (line.startsWith('\t') || line.startsWith('.')) continue // recipe line or .PHONY/special target
    const m = line.match(/^([A-Za-z0-9][\w-]*)\s*:(?!=)/)
    if (m && !targets.includes(m[1])) targets.push(m[1])
  }
  return targets.map((name) => ({
    id: `make:${name}`, source: 'make', label: name, command: 'make', args: [name],
  }))
}

function discoverGradleTasks(cwd) {
  const buildFilePath = ['build.gradle', 'build.gradle.kts'].map((f) => path.join(cwd, f)).find((p) => fs.existsSync(p))
  if (!buildFilePath) return []
  const content = fs.readFileSync(buildFilePath, 'utf8')
  const tasks = new Set()
  for (const m of content.matchAll(/task\s+(\w+)/g)) tasks.add(m[1])
  for (const m of content.matchAll(/tasks\.register\(["'](\w+)["']/g)) tasks.add(m[1])
  const command = fs.existsSync(path.join(cwd, 'gradlew')) ? './gradlew' : 'gradle'
  return [...tasks].map((name) => ({
    id: `gradle:${name}`, source: 'gradle', label: name, command, args: [name],
  }))
}

// Naive scan for a `[project.scripts]` (PEP 621) or `[tool.poetry.scripts]`
// table — collects `key = ...` lines until the next `[` section header.
// Good enough for the common case without a real TOML parser dependency.
function parseScriptsTable(content) {
  const keys = []
  const lines = content.split('\n')
  let inTable = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '[project.scripts]' || line === '[tool.poetry.scripts]') { inTable = true; continue }
    if (inTable && line.startsWith('[')) break
    if (inTable) {
      const m = line.match(/^([\w-]+)\s*=/)
      if (m) keys.push(m[1])
    }
  }
  return keys
}

function discoverPythonScripts(cwd) {
  const pyprojectPath = path.join(cwd, 'pyproject.toml')
  if (!fs.existsSync(pyprojectPath)) return []
  const keys = parseScriptsTable(fs.readFileSync(pyprojectPath, 'utf8'))
  let command, argsPrefix
  if (fs.existsSync(path.join(cwd, 'uv.lock'))) { command = 'uv'; argsPrefix = ['run'] }
  else if (fs.existsSync(path.join(cwd, 'poetry.lock'))) { command = 'poetry'; argsPrefix = ['run'] }
  else { command = 'python'; argsPrefix = ['-m'] }
  return keys.map((name) => ({
    id: `python:${name}`, source: 'python', label: name, command, args: [...argsPrefix, name],
  }))
}

// Rust has no scripts-table convention like npm/poetry — the nearest
// equivalent is a `[[bin]]` binary target in Cargo.toml (or the implicit
// default bin at src/main.rs, named after the package), runnable via
// `cargo run --bin <name>`.
function discoverCargoBins(cwd) {
  const cargoPath = path.join(cwd, 'Cargo.toml')
  if (!fs.existsSync(cargoPath)) return []
  const content = fs.readFileSync(cargoPath, 'utf8')
  const names = new Set()
  const binSectionRe = /\[\[bin\]\][^[]*/g
  for (const m of content.matchAll(binSectionRe)) {
    const nameMatch = m[0].match(/name\s*=\s*"([^"]+)"/)
    if (nameMatch) names.add(nameMatch[1])
  }
  if (names.size === 0 && fs.existsSync(path.join(cwd, 'src', 'main.rs'))) {
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m)
    if (nameMatch) names.add(nameMatch[1])
  }
  return [...names].map((name) => ({
    id: `cargo:${name}`, source: 'cargo', label: name, command: 'cargo', args: ['run', '--bin', name],
  }))
}

const DISCOVERERS = [discoverNpmScripts, discoverMakeTargets, discoverGradleTasks, discoverPythonScripts, discoverCargoBins]

function discoverJobs(service) {
  const cwd = service.cwd || '.'
  const jobs = []
  for (const discover of DISCOVERERS) {
    try {
      jobs.push(...discover(cwd))
    } catch {
      // A malformed package.json/Makefile/build.gradle/pyproject.toml
      // shouldn't stop discovery from the other sources.
    }
  }
  return jobs
}

module.exports = { discoverJobs }
