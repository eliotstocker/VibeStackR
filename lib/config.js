'use strict'

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const Ajv = require('ajv')

const CANDIDATES = ['run-local.config.json', 'run-local.config.yaml', 'run-local.config.yml']

// Compiled once at module load, not per-call — loadConfig() only runs once
// per process, but there's no reason to redo the (fairly expensive) schema
// compile step if that ever changes.
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'run-local.config.schema.json'), 'utf8'))
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

// ROOT is the directory the user invoked `npx vibestakr` from, NOT where the
// vibestakr package itself is installed (__dirname would point into
// node_modules) — the config, services' cwds, and logs all live relative to
// the consuming project, not this package.
function findConfigFile(root) {
  const found = CANDIDATES.filter((f) => fs.existsSync(path.join(root, f)))
  if (found.length === 0) {
    throw new Error(`no config found — expected one of ${CANDIDATES.join(', ')} in ${root}`)
  }
  if (found.length > 1) {
    throw new Error(`multiple configs found (${found.join(', ')}) — keep only one`)
  }
  return path.join(root, found[0])
}

function loadConfig(root) {
  const file = findConfigFile(root)
  const raw = fs.readFileSync(file, 'utf8')
  const config = file.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw)
  if (!validate(config)) {
    throw new Error(`${path.basename(file)} doesn't match the expected schema:\n${formatValidationErrors(validate.errors)}`)
  }
  return { config, file }
}

module.exports = { loadConfig, findConfigFile, CANDIDATES }
