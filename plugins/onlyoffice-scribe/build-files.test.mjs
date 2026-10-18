import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { scribeScriptFiles } from './build-files.mjs'

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
})
