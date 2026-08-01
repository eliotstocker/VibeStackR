'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadConfig, findProjectRoot } = require('../lib/config')

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-config-test-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('loads .vibestackr.json', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify({ services: [{ name: 'web', command: 'true' }] }))
    const { config, file } = loadConfig(dir)
    assert.equal(config.services[0].name, 'web')
    assert.match(file, /\.vibestackr\.json$/)
  })
})

test('loads .vibestackr (no extension, still JSON)', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr'), JSON.stringify({ services: [{ name: 'web', command: 'true' }] }))
    const { config, file } = loadConfig(dir)
    assert.equal(config.services[0].name, 'web')
    assert.match(file, /\.vibestackr$/)
  })
})

test('loads .vibestackr.yaml', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.yaml'), 'services:\n  - name: web\n    command: "true"\n')
    const { config, file } = loadConfig(dir)
    assert.equal(config.services[0].name, 'web')
    assert.match(file, /\.vibestackr\.yaml$/)
  })
})

test('loads .vibestackr.yml', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.yml'), 'services:\n  - name: web\n    command: "true"\n')
    const { config } = loadConfig(dir)
    assert.equal(config.services[0].name, 'web')
  })
})

test('throws a clear error when no config exists', () => {
  withTmpDir((dir) => {
    assert.throws(() => loadConfig(dir), /no config found/)
  })
})

test('throws a clear error when more than one config exists', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), '{"services":[]}')
    fs.writeFileSync(path.join(dir, '.vibestackr.yaml'), 'services: []\n')
    assert.throws(() => loadConfig(dir), /multiple configs found/)
  })
})

test('an explicit path (--config) skips auto-discovery entirely, even with an unconventional name', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'custom.config.json'), JSON.stringify({ services: [{ name: 'web', command: 'true' }] }))
    const { config, file } = loadConfig(dir, 'custom.config.json')
    assert.equal(config.services[0].name, 'web')
    assert.match(file, /custom\.config\.json$/)
  })
})

test('an explicit path is resolved relative to root when not absolute', () => {
  withTmpDir((dir) => {
    fs.mkdirSync(path.join(dir, 'nested'))
    fs.writeFileSync(path.join(dir, 'nested', 'app.yaml'), 'services:\n  - name: web\n    command: "true"\n')
    const { config } = loadConfig(dir, 'nested/app.yaml')
    assert.equal(config.services[0].name, 'web')
  })
})

test('an explicit path that does not exist throws a clear error', () => {
  withTmpDir((dir) => {
    assert.throws(() => loadConfig(dir, 'missing.json'), /config file not found/)
  })
})

test('rejects a config missing a required field, naming the field', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify({ services: [{ name: 'web' }] }))
    assert.throws(() => loadConfig(dir), (err) => {
      assert.match(err.message, /doesn't match the expected schema/)
      assert.match(err.message, /\/services\/0/)
      assert.match(err.message, /'command'/)
      return true
    })
  })
})

test('rejects an unrecognized top-level property, naming it', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify({ services: [], notARealField: true }))
    assert.throws(() => loadConfig(dir), (err) => {
      assert.match(err.message, /'notARealField'/)
      return true
    })
  })
})

test('rejects an invalid liveness type, and reports every problem at once (not just the first)', () => {
  withTmpDir((dir) => {
    const config = {
      services: [
        { name: 'web' }, // missing `command`
        { name: 'db', command: 'true', liveness: { type: 'smoke-signal' } }, // not a real liveness type
      ],
    }
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify(config))
    assert.throws(() => loadConfig(dir), (err) => {
      assert.match(err.message, /'command'/)
      assert.match(err.message, /\/services\/1\/liveness/)
      return true
    })
  })
})

test('accepts a valid config using every top-level and service field', () => {
  withTmpDir((dir) => {
    const config = {
      name: 'MyApp',
      services: [
        {
          name: 'web',
          type: 'node',
          cwd: '.',
          command: 'npm',
          args: ['run', 'dev'],
          env: { FOO: 'bar' },
          note: 'http://localhost:3000',
          oneShot: false,
          watcher: true,
          dependsOn: [],
          liveness: { type: 'port', host: 'localhost', port: 3000, timeout: 60 },
          onSuccess: 'echo done',
          onReady: 'echo ready',
          jsonLog: { format: '${message}', levelField: 'level', colors: { notice: 'cyan' } },
        },
      ],
      dependencies: [{ message: 'need docker', when: [{ commandMissing: 'docker' }] }],
      warnings: [{ service: 'web', message: 'heads up', when: [{ envUnset: 'FOO' }] }],
      shortcuts: [{ key: 'r', label: 'restart web', restart: 'web' }],
    }
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify(config))
    assert.doesNotThrow(() => loadConfig(dir))
  })
})

test('findProjectRoot returns startDir itself when the config lives there', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), '{"services":[]}')
    assert.equal(fs.realpathSync(findProjectRoot(dir)), fs.realpathSync(dir))
  })
})

test('findProjectRoot walks upward to find a config from a nested subdirectory', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.yaml'), 'services: []\n')
    const nested = path.join(dir, 'packages', 'api', 'src')
    fs.mkdirSync(nested, { recursive: true })
    assert.equal(fs.realpathSync(findProjectRoot(nested)), fs.realpathSync(dir))
  })
})

test('findProjectRoot prefers the closest ancestor config over a further one', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), '{"services":[]}')
    const nested = path.join(dir, 'packages', 'api')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, '.vibestackr.json'), '{"services":[]}')
    assert.equal(fs.realpathSync(findProjectRoot(nested)), fs.realpathSync(nested))
  })
})

test('findProjectRoot falls back to startDir when no config exists anywhere above it', () => {
  withTmpDir((dir) => {
    const nested = path.join(dir, 'a', 'b')
    fs.mkdirSync(nested, { recursive: true })
    assert.equal(fs.realpathSync(findProjectRoot(nested)), fs.realpathSync(nested))
  })
})
