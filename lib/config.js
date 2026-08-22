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
  const found = CANDIDATES.filter((f) => {
    const p = path.join(root, f)
    try {
      return fs.statSync(p).isFile()
    } catch (err) {
      return false
    }
  })
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
    const hasConfig = CANDIDATES.some((f) => {
      const p = path.join(dir, f)
      try {
        return fs.statSync(p).isFile()
      } catch (err) {
        return false
      }
    })
    if (hasConfig) return dir
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

function resolvePath(baseDir, relOrAbsPath) {
  return path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.resolve(baseDir, relOrAbsPath)
}

function loadAndExpandConfig(file, root, visited = new Set()) {
  let realFile
  try {
    realFile = fs.realpathSync(file)
  } catch {
    realFile = path.resolve(file)
  }
  if (visited.has(realFile)) {
    throw new Error(`circular sub-stack import detected: ${file}`)
  }
  visited.add(realFile)

  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    throw new Error(`failed to read config file: ${file}`)
  }
  if (!stat.isFile()) {
    throw new Error(`config path is not a file: ${file}`)
  }

  const raw = fs.readFileSync(file, 'utf8')
  const config = parseConfigFile(file, raw)
  if (!validate(config)) {
    throw new Error(`${path.basename(file)} doesn't match the expected schema:\n${formatValidationErrors(validate.errors)}`)
  }

  const currentDir = path.dirname(file)
  const expandedServices = []
  const importedDeps = []
  const importedWarnings = []
  const importedShortcuts = []

  for (const s of config.services) {
    const subPath = s.config || s.stack
    if (!subPath) {
      const relDir = path.relative(root, currentDir)
      const plainService = { ...s }
      if (plainService.cwd && !path.isAbsolute(plainService.cwd)) {
        plainService.cwd = path.normalize(path.join(relDir, plainService.cwd))
      } else if (!plainService.cwd && relDir) {
        plainService.cwd = relDir
      }
      if (plainService.envFile && !path.isAbsolute(plainService.envFile)) {
        plainService.envFile = path.normalize(path.join(relDir, plainService.envFile))
      }
      expandedServices.push(plainService)
      continue
    }

    const stackName = s.name
    const targetPath = resolvePath(currentDir, subPath)
    let subFile
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
      subFile = findConfigFile(targetPath)
    } else if (fs.existsSync(targetPath)) {
      subFile = targetPath
    } else {
      throw new Error(`sub-stack config not found for '${stackName}': ${subPath} (resolved to ${targetPath})`)
    }

    const subResult = loadAndExpandConfig(subFile, root, new Set(visited))
    const subConfig = subResult.config

    let subServices = subConfig.services
    if (s.only && s.only.length) {
      const onlySet = new Set(s.only)
      subServices = subServices.filter((ss) => onlySet.has(ss.name) || onlySet.has(ss.name.split('/').pop()))
    } else if (s.exclude && s.exclude.length) {
      const exSet = new Set(s.exclude)
      subServices = subServices.filter((ss) => !exSet.has(ss.name) && !exSet.has(ss.name.split('/').pop()))
    }

    const subServiceNames = new Set(subServices.map((ss) => ss.name))

    for (const ss of subServices) {
      const newService = { ...ss }
      newService.group = ss.group ? `${stackName}/${ss.group}` : stackName

      const simpleName = ss.name.includes('/') ? ss.name : `${stackName}/${ss.name}`
      newService.name = simpleName

      if (s.env) {
        newService.env = { ...s.env, ...(newService.env || {}) }
      }

      if (ss.dependsOn && ss.dependsOn.length) {
        newService.dependsOn = ss.dependsOn.map((dep) => {
          if (subServiceNames.has(dep)) return ss.name.includes('/') ? dep : `${stackName}/${dep}`
          return dep
        })
      }

      if (s.dependsOn && s.dependsOn.length) {
        newService.dependsOn = [...(newService.dependsOn || []), ...s.dependsOn]
      }

      expandedServices.push(newService)
    }

    if (subConfig.dependencies) {
      for (const d of subConfig.dependencies) {
        importedDeps.push({
          ...d,
          message: d.message ? `[${stackName}] ${d.message}` : d.message,
        })
      }
    }
    if (subConfig.warnings) {
      for (const w of subConfig.warnings) {
        importedWarnings.push({
          ...w,
          service: w.service ? (w.service.includes('/') ? w.service : `${stackName}/${w.service}`) : undefined,
        })
      }
    }
    if (subConfig.shortcuts) {
      for (const sc of subConfig.shortcuts) {
        importedShortcuts.push({
          ...sc,
          restart: sc.restart ? (sc.restart.includes('/') ? sc.restart : `${stackName}/${sc.restart}`) : undefined,
        })
      }
    }
  }

  config.services = expandedServices
  if (importedDeps.length) config.dependencies = [...(config.dependencies || []), ...importedDeps]
  if (importedWarnings.length) config.warnings = [...(config.warnings || []), ...importedWarnings]
  if (importedShortcuts.length) {
    const existingKeys = new Set((config.shortcuts || []).map((sc) => sc.key))
    for (const sc of importedShortcuts) {
      if (!existingKeys.has(sc.key)) {
        config.shortcuts = [...(config.shortcuts || []), sc]
        existingKeys.add(sc.key)
      }
    }
  }

  return { config, file }
}

// `explicitPath` (from --config) skips auto-discovery entirely and is
// resolved relative to `root` if not already absolute.
function loadConfig(root, explicitPath) {
  const file = explicitPath ? path.resolve(root, explicitPath) : findConfigFile(root)
  if (explicitPath && !fs.existsSync(file)) {
    throw new Error(`config file not found: ${file}`)
  }
  return loadAndExpandConfig(file, root)
}

module.exports = { loadConfig, findConfigFile, findProjectRoot, CANDIDATES }
