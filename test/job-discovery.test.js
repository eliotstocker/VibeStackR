'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { discoverJobs } = require('../lib/job-discovery')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibestackr-job-discovery-test-'))
}

test('discoverJobs: no manifests present returns an empty list', () => {
  const dir = tmpDir()
  assert.deepEqual(discoverJobs({ cwd: dir }), [])
})

test('discoverJobs: npm scripts from package.json', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }))
  assert.deepEqual(discoverJobs({ cwd: dir }), [
    { id: 'npm:build', source: 'npm', label: 'build', command: 'npm', args: ['run', 'build'] },
    { id: 'npm:test', source: 'npm', label: 'test', command: 'npm', args: ['run', 'test'] },
  ])
})

test('discoverJobs: Makefile targets, skipping .PHONY and recipe lines', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'Makefile'), '.PHONY: build\nbuild:\n\techo building\ntest:\n\techo testing\n')
  assert.deepEqual(discoverJobs({ cwd: dir }), [
    { id: 'make:build', source: 'make', label: 'build', command: 'make', args: ['build'] },
    { id: 'make:test', source: 'make', label: 'test', command: 'make', args: ['test'] },
  ])
})

test('discoverJobs: Gradle tasks from build.gradle (Groovy) and build.gradle.kts (Kotlin DSL)', () => {
  const groovyDir = tmpDir()
  fs.writeFileSync(path.join(groovyDir, 'build.gradle'), 'task build {\n}\ntasks.register("lint") {\n}\n')
  assert.deepEqual(discoverJobs({ cwd: groovyDir }), [
    { id: 'gradle:build', source: 'gradle', label: 'build', command: 'gradle', args: ['build'] },
    { id: 'gradle:lint', source: 'gradle', label: 'lint', command: 'gradle', args: ['lint'] },
  ])

  const ktsDir = tmpDir()
  fs.writeFileSync(path.join(ktsDir, 'build.gradle.kts'), 'tasks.register("check") {\n}\n')
  fs.writeFileSync(path.join(ktsDir, 'gradlew'), '#!/bin/sh\n')
  assert.deepEqual(discoverJobs({ cwd: ktsDir }), [
    { id: 'gradle:check', source: 'gradle', label: 'check', command: './gradlew', args: ['check'] },
  ])
})

test('discoverJobs: python scripts from pyproject.toml, runner picked by which lockfile is present', () => {
  const uvDir = tmpDir()
  fs.writeFileSync(path.join(uvDir, 'pyproject.toml'), '[project.scripts]\nserve = "app:main"\n')
  fs.writeFileSync(path.join(uvDir, 'uv.lock'), '')
  assert.deepEqual(discoverJobs({ cwd: uvDir }), [
    { id: 'python:serve', source: 'python', label: 'serve', command: 'uv', args: ['run', 'serve'] },
  ])

  const poetryDir = tmpDir()
  fs.writeFileSync(path.join(poetryDir, 'pyproject.toml'), '[tool.poetry.scripts]\nserve = "app:main"\n')
  fs.writeFileSync(path.join(poetryDir, 'poetry.lock'), '')
  assert.deepEqual(discoverJobs({ cwd: poetryDir }), [
    { id: 'python:serve', source: 'python', label: 'serve', command: 'poetry', args: ['run', 'serve'] },
  ])

  const bareDir = tmpDir()
  fs.writeFileSync(path.join(bareDir, 'pyproject.toml'), '[project.scripts]\nserve = "app:main"\n')
  assert.deepEqual(discoverJobs({ cwd: bareDir }), [
    { id: 'python:serve', source: 'python', label: 'serve', command: 'python', args: ['-m', 'serve'] },
  ])
})

test('discoverJobs: a malformed package.json does not stop Makefile/gradle/python discovery', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not valid json')
  fs.writeFileSync(path.join(dir, 'Makefile'), 'build:\n\techo building\n')
  assert.deepEqual(discoverJobs({ cwd: dir }), [
    { id: 'make:build', source: 'make', label: 'build', command: 'make', args: ['build'] },
  ])
})

test('discoverJobs: Cargo.toml [[bin]] targets, and the implicit default bin at src/main.rs', () => {
  const multiBinDir = tmpDir()
  fs.writeFileSync(path.join(multiBinDir, 'Cargo.toml'), '[package]\nname = "myapp"\n\n[[bin]]\nname = "server"\npath = "src/server.rs"\n\n[[bin]]\nname = "cli"\npath = "src/cli.rs"\n')
  assert.deepEqual(discoverJobs({ cwd: multiBinDir }), [
    { id: 'cargo:server', source: 'cargo', label: 'server', command: 'cargo', args: ['run', '--bin', 'server'] },
    { id: 'cargo:cli', source: 'cargo', label: 'cli', command: 'cargo', args: ['run', '--bin', 'cli'] },
  ])

  const defaultBinDir = tmpDir()
  fs.writeFileSync(path.join(defaultBinDir, 'Cargo.toml'), '[package]\nname = "myapp"\n')
  fs.mkdirSync(path.join(defaultBinDir, 'src'))
  fs.writeFileSync(path.join(defaultBinDir, 'src', 'main.rs'), 'fn main() {}\n')
  assert.deepEqual(discoverJobs({ cwd: defaultBinDir }), [
    { id: 'cargo:myapp', source: 'cargo', label: 'myapp', command: 'cargo', args: ['run', '--bin', 'myapp'] },
  ])
})

test('discoverJobs: sources combine when multiple manifests coexist in the same cwd', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }))
  fs.writeFileSync(path.join(dir, 'Makefile'), 'build:\n\techo building\n')
  const jobs = discoverJobs({ cwd: dir })
  assert.deepEqual(jobs.map((j) => j.id).sort(), ['make:build', 'npm:build'])
})
