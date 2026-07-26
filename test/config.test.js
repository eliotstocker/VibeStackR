'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadConfig } = require('../lib/config')

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestakr-config-test-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('loads run-local.config.json', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'run-local.config.json'), JSON.stringify({ services: [{ name: 'web', command: 'true' }] }))
    const { config, file } = loadConfig(dir)
    assert.equal(config.services[0].name, 'web')
    assert.match(file, /run-local\.config\.json$/)
  })
})

test('loads run-local.config.yaml', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'run-local.config.yaml'), 'services:\n  - name: web\n    command: "true"\n')
    const { config, file } = loadConfig(dir)
    assert.equal(config.services[0].name, 'web')
    assert.match(file, /run-local\.config\.yaml$/)
  })
})

test('loads run-local.config.yml', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'run-local.config.yml'), 'services:\n  - name: web\n    command: "true"\n')
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
    fs.writeFileSync(path.join(dir, 'run-local.config.json'), '{"services":[]}')
    fs.writeFileSync(path.join(dir, 'run-local.config.yaml'), 'services: []\n')
    assert.throws(() => loadConfig(dir), /multiple configs found/)
  })
})

test('rejects a config missing a required field, naming the field', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'run-local.config.json'), JSON.stringify({ services: [{ name: 'web' }] }))
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
    fs.writeFileSync(path.join(dir, 'run-local.config.json'), JSON.stringify({ services: [], notARealField: true }))
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
    fs.writeFileSync(path.join(dir, 'run-local.config.json'), JSON.stringify(config))
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
    fs.writeFileSync(path.join(dir, 'run-local.config.json'), JSON.stringify(config))
    assert.doesNotThrow(() => loadConfig(dir))
  })
})
