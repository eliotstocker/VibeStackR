'use strict'

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const Ajv = require('ajv')

const CANDIDATES = ['.vibestackr.yaml', '.vibestackr.yml', '.vibestackr.json', '.vibestackr']

// Compiled once at module load, not per-call — loadConfig() only runs once
// per process, but there's no reason to redo the (fairly expensive) schema
// compile step if that ever changes.
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'config.schema.json'), 'utf8'))
const validate = new Ajv({ allErrors: true }).compile(schema)

// ajv's own messages are fine for most keywords (`required` already names
// the missing property) but say nothing useful for `additionalProperties`
// beyond "must NOT have additional properties" — append which one.
function formatValidationErrors(errors) {
  return errors
    .map((e) => {
      const extra = e.keyword === 'additionalProperties' ? ` ('${e.params.additionalProperty}')` : ''
      return `  - ${e.instancePath || '(root)'}: ${e.message}${extra}`
    })
    .join('\n')
}

// ROOT is the directory the user invoked `npx vibestackr` from, NOT where the
// vibestackr package itself is installed (__dirname would point into
// node_modules) — the config, services' cwds, and logs all live relative to
// the consuming project, not this package.
function findConfigFile(root) {
  const found = CANDIDATES.filter((f) => fs.existsSync(path.join(root, f)))
  if (found.length === 0) {
    throw new Error(`no config found — expected one of ${CANDIDATES.join(', ')} in ${root} (or pass --config <path>)`)
  }
  if (found.length > 1) {
    throw new Error(`multiple configs found (${found.join(', ')}) — keep only one, or pass --config <path> to pick one explicitly`)
  }
  return path.join(root, found[0])
}

// Walks upward from startDir looking for a directory containing one of
// CANDIDATES, the same way git/eslint/etc find their own project root — lets
// `vibestackr` (and its subcommands) be run from any subdirectory of a
// project, not just wherever the config actually lives. Falls back to
// startDir itself if nothing is found anywhere above it, so callers get
// today's cwd-relative "no config found" error unchanged rather than a
// different failure mode for the not-in-a-project case.
function findProjectRoot(startDir) {
  let dir = path.resolve(startDir)
  for (;;) {
    if (CANDIDATES.some((f) => fs.existsSync(path.join(dir, f)))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return startDir
    dir = parent
  }
}

// Only an explicit .yaml/.yml extension is treated as YAML — everything else
// (.json, or no extension at all, e.g. a plain `.vibestackr`) parses as JSON.
function parseConfigFile(file, raw) {
  const ext = path.extname(file)
  return ext === '.yaml' || ext === '.yml' ? YAML.parse(raw) : JSON.parse(raw)
}

// `explicitPath` (from --config) skips auto-discovery entirely and is
// resolved relative to `root` if not already absolute.
function loadConfig(root, explicitPath) {
  const file = explicitPath ? path.resolve(root, explicitPath) : findConfigFile(root)
  if (explicitPath && !fs.existsSync(file)) {
    throw new Error(`config file not found: ${file}`)
  }
  const raw = fs.readFileSync(file, 'utf8')
  const config = parseConfigFile(file, raw)
  if (!validate(config)) {
    throw new Error(`${path.basename(file)} doesn't match the expected schema:\n${formatValidationErrors(validate.errors)}`)
  }
  return { config, file }
}

module.exports = { loadConfig, findConfigFile, findProjectRoot, CANDIDATES }
