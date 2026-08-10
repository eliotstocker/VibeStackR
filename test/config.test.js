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

test('findProjectRoot and findConfigFile ignore directories with candidate names', () => {
  withTmpDir((dir) => {
    fs.mkdirSync(path.join(dir, '.vibestackr'))
    assert.throws(() => loadConfig(dir), /no config found/)
    const nested = path.join(dir, 'nested')
    fs.mkdirSync(nested)
    assert.equal(fs.realpathSync(findProjectRoot(nested)), fs.realpathSync(nested))
  })
})

test('findProjectRoot and findConfigFile ignore directories with candidate names and find real config files', () => {
  withTmpDir((dir) => {
    fs.mkdirSync(path.join(dir, '.vibestackr'))
    fs.writeFileSync(path.join(dir, '.vibestackr.json'), JSON.stringify({ services: [{ name: 'web', command: 'true' }] }))
    const { config, file } = loadConfig(dir)
    assert.equal(config.services[0].name, 'web')
    assert.match(file, /\.vibestackr\.json$/)
  })
})

test('loadConfig with explicit path that is a directory throws a clear error', () => {
  withTmpDir((dir) => {
    const dirPath = path.join(dir, 'config-dir')
    fs.mkdirSync(dirPath)
    assert.throws(() => loadConfig(dir, 'config-dir'), /config path is not a file/)
  })
})

test('loads sub-stack config, namespaces services, resolves cwds and rewrites internal dependsOn', () => {
  withTmpDir((dir) => {
    const subDir = path.join(dir, 'sub')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(
      path.join(subDir, '.vibestackr.yaml'),
      `services:
  - name: db
    command: "echo db"
  - name: api
    command: "echo api"
    cwd: "./server"
    envFile: ".env"
    dependsOn:
      - db
`
    )
    fs.writeFileSync(
      path.join(dir, '.vibestackr.yaml'),
      `services:
  - name: auth
    config: ./sub
  - name: frontend
    command: "echo frontend"
    dependsOn:
      - auth/api
`
    )

    const { config } = loadConfig(dir)
    assert.equal(config.services.length, 3)

    const db = config.services.find((s) => s.name === 'auth/db')
    assert.ok(db)
    assert.equal(db.group, 'auth')
    assert.equal(db.cwd, 'sub')

    const api = config.services.find((s) => s.name === 'auth/api')
    assert.ok(api)
    assert.equal(api.group, 'auth')
    assert.equal(api.cwd, path.normalize('sub/server'))
    assert.equal(api.envFile, path.normalize('sub/.env'))
    assert.deepEqual(api.dependsOn, ['auth/db'])

    const fe = config.services.find((s) => s.name === 'frontend')
    assert.ok(fe)
    assert.deepEqual(fe.dependsOn, ['auth/api'])
  })
})

test('sub-stack inherits dependencies, warnings, and shortcuts', () => {
  withTmpDir((dir) => {
    const subDir = path.join(dir, 'auth-pkg')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(
      path.join(subDir, '.vibestackr.json'),
      JSON.stringify({
        services: [{ name: 'server', command: 'true' }],
        dependencies: [{ message: 'need redis', when: [{ commandMissing: 'redis-cli' }] }],
        warnings: [{ service: 'server', message: 'check config' }],
        shortcuts: [{ key: 'a', label: 'restart auth', restart: 'server' }],
      })
    )
    fs.writeFileSync(
      path.join(dir, '.vibestackr.json'),
      JSON.stringify({
        services: [{ name: 'auth', config: './auth-pkg' }],
      })
    )

    const { config } = loadConfig(dir)
    assert.equal(config.services[0].name, 'auth/server')
    assert.equal(config.dependencies[0].message, '[auth] need redis')
    assert.equal(config.warnings[0].service, 'auth/server')
    assert.equal(config.shortcuts[0].restart, 'auth/server')
  })
})

test('sub-stack respects exclude and only filters on sub-stack declaration', () => {
  withTmpDir((dir) => {
    const subDir = path.join(dir, 'services')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(
      path.join(subDir, '.vibestackr.yaml'),
      `services:
  - name: s1
    command: "true"
  - name: s2
    command: "true"
`
    )
    fs.writeFileSync(
      path.join(dir, '.vibestackr.yaml'),
      `services:
  - name: stack1
    config: ./services
    only:
      - s1
`
    )

    const { config } = loadConfig(dir)
    assert.equal(config.services.length, 1)
    assert.equal(config.services[0].name, 'stack1/s1')
  })
})

test('detects circular sub-stack imports', () => {
  withTmpDir((dir) => {
    const a = path.join(dir, 'a.yaml')
    const b = path.join(dir, 'b.yaml')
    fs.writeFileSync(a, `services:\n  - name: b\n    config: ${b}\n`)
    fs.writeFileSync(b, `services:\n  - name: a\n    config: ${a}\n`)
    assert.throws(() => loadConfig(dir, 'a.yaml'), /circular sub-stack import detected/)
  })
})

