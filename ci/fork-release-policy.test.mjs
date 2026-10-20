import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const yaml = readFileSync(new URL('../.github/workflows/ci-cd.yml', import.meta.url), 'utf8')
const protectedStep = name => {
  const lines = yaml.split(/\r?\n/)
  const index = lines.findIndex(line => line === '      - name: ' + name)
  assert.ok(index >= 0, name + ' step must exist')
  const condition = lines[index + 1]?.match(/^        if: (.+)$/)
  assert.ok(condition, name + ' requires an explicit release gate')
  return condition[1]
}

test('fork builds cannot acquire upstream SSH deployment credentials', () => {
  const condition = protectedStep('Set SSH for downcloud')
  assert.match(condition, /github\.event\.repository\.fork == false/)
  assert.match(condition, /github\.ref == 'refs\/heads\/master'/)
  assert.match(condition, /startsWith\(github\.ref, 'refs\/tags\/'\)/)
})

test('fork branches and fork tags cannot publish the upstream Drive application', () => {
  const condition = protectedStep('Publish')
  assert.match(condition, /github\.event\.repository\.fork == false/)
  assert.equal(condition, protectedStep('Set SSH for downcloud'))
  assert.match(yaml, /^permissions:\s*\r?\n  contents: read\s*$/m)
})
