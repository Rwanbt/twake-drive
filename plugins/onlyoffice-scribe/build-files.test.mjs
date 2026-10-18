import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { assertScribePackage, scribeScriptFiles } from './build-files.mjs'

const source = dirname(fileURLToPath(import.meta.url))
const scripts = join(source, 'scripts')

test('every relative runtime JS import is in the packaged Document Server plugin', () => {
  const all = scribeScriptFiles(scripts)
  assert.ok(all.includes('scribe.js'))
  assert.ok(all.includes('host-messages.mjs'), 'missing authorization helper breaks plugin initialization')
  const discovered = new Set(all)
  for (const name of all) {
    const file = readFileSync(join(scripts, name), 'utf8')
    for (const match of file.matchAll(/\bfrom\s*['"](\.\/[^'"]+)['"]/g)) {
      const dependency = match[1].slice(2)
      assert.ok(discovered.has(dependency), name + ' imports ' + dependency + ' but build omits it')
    }
  }
})

test('build cannot package tests or arbitrary non-JavaScript files', () => {
  const packed = scribeScriptFiles(scripts)
  assert.ok(packed.length > 1)
  for (const file of packed) {
    assert.match(file, /\.(?:js|mjs)$/)
    assert.doesNotMatch(file, /\.(?:test|spec)\./)
  }
  for (const name of readdirSync(scripts).filter(name => /\.(?:test|spec)\.(?:mjs|js)$/.test(name))) {
    assert.ok(!packed.includes(name), name + ' must not be shipped')
  }
})

test('the actual packager calls the reviewed runtime inventory', () => {
  const builder = readFileSync(join(source, 'build.mjs'), 'utf8')
  assert.match(builder, /scribeScriptFiles\(join\(source, 'scripts'\)\)/)
  assert.doesNotMatch(builder, /name\.endsWith\('\.js'\)/)
  assert.match(builder, /assertScribePackage\(output\)/)
})

function packagedFixture(run) {
  const output = mkdtempSync(join(tmpdir(), 'twake-scribe-packaging-'))
  const packagedScripts = join(output, 'scripts')
  try {
    mkdirSync(packagedScripts)
    for (const file of scribeScriptFiles(scripts)) {
      cpSync(join(scripts, file), join(packagedScripts, file))
    }
    cpSync(join(source, 'index.html'), join(output, 'index.html'))
    return run({ output, packagedScripts })
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
}

test('distributed output accepts complete entrypoint and import graph', () => {
  packagedFixture(({ output }) => {
    const files = assertScribePackage(output)
    assert.ok(files.includes('scribe.js'))
    assert.ok(files.includes('host-messages.mjs'))
  })
})

test('distributed output fails closed when the host-security ESM dependency is absent', () => {
  packagedFixture(({ output, packagedScripts }) => {
    rmSync(join(packagedScripts, 'host-messages.mjs'))
    assert.throws(() => assertScribePackage(output), /Missing Scribe runtime import/)
  })
})

test('distributed output rejects accidental shipping of security-test source', () => {
  packagedFixture(({ output, packagedScripts }) => {
    writeFileSync(join(packagedScripts, 'private.test.mjs'), 'export {}')
    assert.throws(() => assertScribePackage(output), /Test source shipped/)
  })
})

test('distributed output refuses missing or non-module browser entrypoint', () => {
  packagedFixture(({ output }) => {
    writeFileSync(join(output, 'index.html'), '<script src="scripts/scribe.js"></script>')
    assert.throws(() => assertScribePackage(output), /ESM entrypoint/)
  })
})
