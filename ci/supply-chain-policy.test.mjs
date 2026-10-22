import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const repositoryRoot = join(import.meta.dirname, '..')

const workflow = readFileSync(
  join(repositoryRoot, '.github', 'workflows', 'supply-chain.yml'),
  'utf8'
)

const sentry = readFileSync(
  join(repositoryRoot, 'src', 'lib', 'sentry.js'),
  'utf8'
)

const longPressSpec = readFileSync(
  join(repositoryRoot, 'src', 'hooks', 'useOnLongPress', 'helpers.spec.jsx'),
  'utf8'
)

test('every third-party action is pinned to an exact commit', () => {
  const uses = [...workflow.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g)].map(
    match => `${match[1]}@${match[2]}`
  )
  assert.ok(uses.length >= 5, 'the supply chain workflow must use several actions')
  for (const use of uses) {
    assert.match(
      use,
      /@[0-9a-f]{40}$/,
      `action is not pinned to an exact commit: ${use}`
    )
  }
})

test('the supply chain workflow never grants a pull request scope', () => {
  assert.doesNotMatch(workflow, /pull-requests:\s*write/)
  assert.doesNotMatch(workflow, /contents:\s*write/)
})

test('vulnerabilities, secrets and misconfigurations are all scanned', () => {
  assert.match(workflow, /scanners:\s*vuln,secret,misconfig/)
  assert.match(workflow, /severity:\s*UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL/)
  // Trivy is the scanner that covers the three families above.
  assert.match(workflow, /aquasecurity\/trivy-action@[0-9a-f]{40}/)
})

test('a critical finding fails the job instead of being reported and ignored', () => {
  assert.match(workflow, /"CRITICAL"/)
  assert.match(workflow, /sys\.exit\(1\)/)
  assert.doesNotMatch(workflow, /continue-on-error/)
  assert.doesNotMatch(workflow, /exit-code:\s*'1'/)
  // The report is published even when the gate fails, so a rejected finding
  // can be read and justified.
  assert.match(workflow, /name:\s*trivy-report/)
  assert.match(workflow, /if:\s*always\(\)/)
  assert.match(workflow, /GITHUB_STEP_SUMMARY/)
})

test('the bills of materials are published and carry an attested provenance', () => {
  assert.match(workflow, /format:\s*cyclonedx-json/)
  assert.match(workflow, /format:\s*spdx-json/)
  assert.match(workflow, /if-no-files-found:\s*error/)
  assert.match(workflow, /sha256sum/)
  assert.match(workflow, /actions\/attest-build-provenance@[0-9a-f]{40}/)
  assert.match(workflow, /attestations:\s*write/)
  assert.match(workflow, /id-token:\s*write/)
  assert.match(workflow, /subject-path:\s*attest\/sbom\.cdx\.json/)
})

test('no error report leaves the deployment unless the operator asked for it', () => {
  // The Sentry DSN must never be baked into the bundle: a self-hosted
  // deployment would report its errors to a third party it did not choose.
  assert.doesNotMatch(
    sentry,
    /https:\/\/[a-f0-9]+@[^'"]*sentry[^'"]*\/[0-9]+/,
    'a Sentry DSN is hardcoded in src/lib/sentry.js'
  )
  assert.doesNotMatch(sentry, /errors\.cozycloud\.cc/)
  assert.match(sentry, /__SENTRY_DSN__/)
  // Sentry must stay disabled when no DSN is configured.
  assert.match(sentry, /if \(sentryDsn\)/)
})

test('the build injects the opt-in Sentry DSN', () => {
  const buildConfig = readFileSync(
    join(repositoryRoot, 'rsbuild.config.mjs'),
    'utf8'
  )
  assert.match(buildConfig, /__SENTRY_DSN__/)
  assert.match(buildConfig, /PUBLIC_SENTRY_DSN/)
})

test('the default click behaviour of useOnLongPress stays covered', () => {
  // A disabled test used to assert the former behaviour, where a default
  // click toggled the item. The implementation now selects the item and
  // toggles only on Ctrl/Cmd click. The disabled test was removed because it
  // contradicted the implementation; these three tests cover the behaviour it
  // used to guard.
  assert.doesNotMatch(longPressSpec, /\bxit\(/)
  assert.match(longPressSpec, /it\('should replace selection on simple click'/)
  assert.match(longPressSpec, /it\('should toggle item on Ctrl\+Click'/)
  assert.match(longPressSpec, /it\('should toggle item on Cmd\+Click \(metaKey\)'/)
})

test('the tracked files are the ones the policy was written against', () => {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
  assert.ok(tracked.includes('src/lib/sentry.js'))
  assert.ok(tracked.includes('.github/workflows/supply-chain.yml'))
})
