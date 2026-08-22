'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DOCKERFILE = path.join(__dirname, 'docker', 'Dockerfile.bootstrap')
const IMAGE_NAME = 'vibestackr-bootstrap-test'
const CONTAINER_NAME = `vibestackr-boot-test-${Date.now()}`

function isDockerAvailable() {
  const res = spawnSync('docker', ['info'], { encoding: 'utf8' })
  return res.status === 0
}

const waitUntil = async (predicate, { timeout = 60000, interval = 1000 } = {}) => {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function execInContainer(cmd) {
  const res = spawnSync('docker', ['exec', CONTAINER_NAME, 'sh', '-c', cmd], { encoding: 'utf8' })
  return res
}

test('Docker Bootstrap: Clean environment builds & runs Java, Python, Go, and Node services via mise', async (t) => {
  if (!isDockerAvailable()) {
    t.skip('Docker daemon is not running/available')
    return
  }

  // 1. Build Docker test image
  const buildRes = spawnSync('docker', ['build', '-t', IMAGE_NAME, '-f', DOCKERFILE, '.'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  })
  assert.equal(buildRes.status, 0, `docker build failed:\n${buildRes.stderr}\n${buildRes.stdout}`)

  // 2. Prepare temporary project directory
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-docker-test-'))
  const miseToml = `
[tools]
java = "temurin-21"
python = "3.12"
go = "1.22"
`
  const config = {
    services: [
      { name: 'node-svc', command: 'node', args: ['-e', 'console.log("BOOTSTRAP_NODE_OK " + process.version); setTimeout(() => {}, 30000);'] },
      { name: 'python-svc', command: 'python3', args: ['-c', 'import sys; print("BOOTSTRAP_PYTHON_OK " + sys.version); import time; time.sleep(30)'] },
      { name: 'go-svc', command: 'sh', args: ['-c', 'go version; sleep 30'] },
      { name: 'java-svc', command: 'sh', args: ['-c', 'java -version 2>&1; sleep 30'] },
    ],
  }

  fs.writeFileSync(path.join(root, 'mise.toml'), miseToml)
  fs.writeFileSync(path.join(root, '.vibestackr.json'), JSON.stringify(config, null, 2))

  let containerStarted = false
  try {
    // 3. Launch container with mounted test project root
    const runRes = spawnSync('docker', [
      'run', '-d',
      '--name', CONTAINER_NAME,
      '-v', `${root}:/project`,
      '-w', '/project',
      IMAGE_NAME,
      'sh', '-c', 'node /app/bin/vibestackr --background && sleep 300',
    ], { encoding: 'utf8' })

    assert.equal(runRes.status, 0, `docker run failed: ${runRes.stderr}`)
    containerStarted = true

    // 4. Poll until all services produce expected log output
    let nodeLogs = ''
    let pythonLogs = ''
    let goLogs = ''
    let javaLogs = ''

    await waitUntil(async () => {
      const fetchLogs = (service) => {
        const script = `node -e "const { requestSocket } = require('/app/lib/control-socket'); requestSocket('/project', 'logs', { name: '${service}' }).then((r) => console.log((r.lines || []).join('\\n'))).catch(() => {})"`
        const res = execInContainer(script)
        return res.stdout || ''
      }

      nodeLogs = fetchLogs('node-svc')
      pythonLogs = fetchLogs('python-svc')
      goLogs = fetchLogs('go-svc')
      javaLogs = fetchLogs('java-svc')

      return nodeLogs.includes('BOOTSTRAP_NODE_OK') &&
             pythonLogs.includes('BOOTSTRAP_PYTHON_OK') &&
             goLogs.includes('go version') &&
             (javaLogs.includes('Runtime Environment') || javaLogs.includes('version') || javaLogs.includes('OpenJDK'))
    }, { timeout: 120000, interval: 2000 })

    assert.match(nodeLogs, /BOOTSTRAP_NODE_OK v20\./)
    assert.match(pythonLogs, /BOOTSTRAP_PYTHON_OK 3\.12\./)
    assert.match(goLogs, /go version go1\.22\./)
    assert.match(javaLogs, /21\./)

  } finally {
    if (containerStarted) {
      spawnSync('docker', ['rm', '-f', CONTAINER_NAME])
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
