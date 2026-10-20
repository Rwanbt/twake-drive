import { execFileSync } from 'child_process'
import { createHmac, pbkdf2Sync, randomBytes } from 'crypto'

import type { FullConfig } from '@playwright/test'

import { saveAuthState } from '../helpers/auth'
import {
  ADMIN_PASSPHRASE,
  ADMIN_USER,
  applyConfigUpdate,
  buildUsers,
  composeArgs,
  getAdminUrl,
  getStackUrl,
  MAX_WORKERS,
  ORG_DOMAIN,
  ORG_ID,
  PERSIST,
  RESET,
  User,
  stackExec
} from '../helpers/config'
import { DEFAULT_FLAGS, setFlags } from '../helpers/flags'
import {
  resolveE2EPorts,
  withPortAllocationLock,
  type E2EPortsConfig
} from '../helpers/ports'

const ADMIN_AUTH = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSPHRASE}`).toString('base64')}`

function compose(...args: string[]): void {
  execFileSync('docker', composeArgs(...args), {
    encoding: 'utf-8',
    cwd: process.cwd(),
    stdio: 'inherit'
  })
}

async function instanceExists(user: User): Promise<boolean> {
  const res = await fetch(`${getAdminUrl()}/instances/${user.instance}`, {
    headers: { Authorization: ADMIN_AUTH, Accept: 'application/json' }
  })
  if (res.ok) return true
  if (res.status === 404) return false
  throw new Error(
    `Failed to inspect instance ${user.instance} (${res.status}): ${await res.text()}`
  )
}

async function createInstance(user: User): Promise<void> {
  if (await instanceExists(user)) {
    console.log(`[e2e] Reusing instance for ${user.label} (${user.instance}).`)
    return
  }

  const params = new URLSearchParams({
    Domain: user.instance,
    Email: user.email,
    Locale: 'en',
    Passphrase: user.passphrase,
    ContextName: 'default',
    OrgID: ORG_ID,
    OrgDomain: ORG_DOMAIN
  })
  const res = await fetch(`${getAdminUrl()}/instances?${params}`, {
    method: 'POST',
    headers: { Authorization: ADMIN_AUTH, Accept: 'application/json' }
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `Failed to create instance ${user.instance} (${res.status}): ${body}`
    )
  }
}

async function waitForStack(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/version`)
      if (res.ok) return
    } catch {
      // stack not up yet
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`cozy-stack did not become ready within ${timeoutMs}ms`)
}

async function verifyOfficeNetwork(
  portsConfig: E2EPortsConfig,
  users: User[]
): Promise<void> {
  if (process.env.COZY_E2E_ONLYOFFICE_JWT_ENABLED === 'true') {
    // Fail the real JWT E2E gate if DocumentServer silently starts with JWT
    // disabled or with a different signing key. Report only which assertions
    // fail: never log keys, encoded tokens or the raw DocumentServer config.
    // The DocumentServer image exposes Python 3 for our network probes;
    // unlike `node`, it is available in its root image execution PATH.
    const validateJwtConfig = `
import json
import os
import sys
with open('/etc/onlyoffice/documentserver/local.json', encoding='utf-8') as source:
    conf = json.load(source).get('services', {}).get('CoAuthoring', {})
enabled = conf.get('token', {}).get('enable', {})
secret = os.environ.get('JWT_SECRET', '')
configured = conf.get('secret', {})
checks = {
    'env': bool(secret),
    'browser': enabled.get('browser') is True,
    'inbox': enabled.get('request', {}).get('inbox') is True,
    'outbox': enabled.get('request', {}).get('outbox') is True,
    'inboxKey': bool(secret) and configured.get('inbox', {}).get('string') == secret,
    'outboxKey': bool(secret) and configured.get('outbox', {}).get('string') == secret,
    'sessionKey': bool(secret) and configured.get('session', {}).get('string') == secret
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    sys.stderr.write('JWT_ASSERTIONS_FAILED:' + ','.join(failed) + '\\n')
    sys.exit(1)
    `
    try {
      execFileSync('docker', composeArgs('exec', '-T', 'onlyoffice', 'python3', '-c', validateJwtConfig), {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      const stderr = String((error as { stderr?: Buffer | string }).stderr || '')
      const failed = stderr.match(/JWT_ASSERTIONS_FAILED:([a-zA-Z,]+)/)?.[1]
      throw new Error(
        failed
          ? `OnlyOffice JWT mode mismatch (failed: ${failed})`
          : 'OnlyOffice JWT configuration inspection could not run'
      )
    }
  }
  const officeUrl = `http://onlyoffice.${portsConfig.rootDomain}:${portsConfig.onlyofficePort}`
  const apiResponse = await fetch(`${officeUrl}/web-apps/apps/api/documents/api.js`)
  if (!apiResponse.ok) {
    throw new Error(`OnlyOffice browser API unavailable (${apiResponse.status})`)
  }

  if (process.env.COZY_E2E_ONLYOFFICE_JWT_ENABLED === 'true') {
    // Exercise the actual DocumentServer command endpoint, not just a JSON
    // setting. Unsigned and incorrectly signed requests must be rejected;
    // a correctly signed disposable request must be accepted.
    const secret = process.env.COZY_E2E_ONLYOFFICE_JWT_SECRET
    if (!secret) throw new Error('Missing disposable DocumentServer JWT key')
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ c: 'version' })).toString('base64url')
    const unsigned = `${header}.${payload}`
    const signature = createHmac('sha256', secret).update(unsigned).digest('base64url')
    const token = `${unsigned}.${signature}`
    const commandError = async (body: Record<string, string>): Promise<number> => {
      const response = await fetch(`${officeUrl}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!response.ok) {
        throw new Error(`OnlyOffice command endpoint unavailable (${response.status})`)
      }
      const result = (await response.json()) as { error?: number }
      return result.error ?? -1
    }
    const unsignedResult = await commandError({ c: 'version' })
    const forgedResult = await commandError({ token: `${unsigned}.${'0'.repeat(43)}` })
    const signedResult = await commandError({ token })
    if (unsignedResult !== 6 || forgedResult !== 6 || signedResult !== 0) {
      throw new Error(
        `OnlyOffice JWT command contract failed: unsigned=${unsignedResult} forged=${forgedResult} signed=${signedResult}`
      )
    }
  }

  for (const user of users) {
    execFileSync(
      'docker',
      composeArgs(
        'exec', '-T', 'onlyoffice', 'python3', '-c',
        'import sys, urllib.request; opener = urllib.request.build_opener(urllib.request.ProxyHandler({})); assert opener.open(sys.argv[1], timeout=5).status == 200',
        `http://${user.instance}/version`
      ),
      { cwd: process.cwd(), stdio: 'ignore' }
    )
  }

  execFileSync(
    'docker',
    composeArgs(
      'exec', '-T', 'cozystack', 'node', '-e',
      '(async () => { const response = await fetch(process.argv[1]); if (!response.ok || (await response.text()).trim() !== "true") process.exit(1) })().catch(() => process.exit(1))',
      `${officeUrl}/healthcheck`
    ),
    { cwd: process.cwd(), stdio: 'ignore' }
  )
}

interface LoginParams {
  csrfToken: string
  iterations: number
  salt: string
}

function parseLoginParams(html: string, instance: string): LoginParams {
  const find = (pattern: RegExp, label: string): string => {
    const m = html.match(pattern)
    if (!m) throw new Error(`Could not find ${label} for ${instance}`)
    return m[1]
  }
  return {
    csrfToken: find(/name="csrf_token"\s+value="([^"]+)"/, 'CSRF token'),
    iterations: parseInt(find(/data-iterations="(\d+)"/, 'PBKDF2 iterations'), 10),
    salt: find(/data-salt="([^"]+)"/, 'PBKDF2 salt')
  }
}

async function getSessionCookie(
  user: User
): Promise<{ name: string; value: string }> {
  const { instance, passphrase } = user
  const loginPageRes = await fetch(`http://${instance}/auth/login`)
  if (!loginPageRes.ok) {
    throw new Error(
      `GET /auth/login on ${instance} failed (${loginPageRes.status}): ${await loginPageRes.text()}`
    )
  }
  const params = parseLoginParams(await loginPageRes.text(), instance)

  // Two-step PBKDF2 hash matching cozy-stack's password-helpers.js:
  // 1. master = PBKDF2(password, salt, iterations, 32, sha256)
  // 2. hashed = PBKDF2(master, password, 1, 32, sha256) — base64-encoded.
  const master = pbkdf2Sync(passphrase, params.salt, params.iterations, 32, 'sha256')
  const hashed = pbkdf2Sync(Uint8Array.from(master), passphrase, 1, 32, 'sha256')

  const initialCookies = loginPageRes.headers.getSetCookie?.() ?? []
  const res = await fetch(`http://${instance}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: initialCookies.map(c => c.split(';')[0]).join('; ')
    },
    body: new URLSearchParams({
      passphrase: hashed.toString('base64'),
      csrf_token: params.csrfToken
    }),
    redirect: 'manual'
  })

  // Session cookie name is dynamic: sess-<hash> with Domain=cozy.localhost.
  const setCookies = res.headers.getSetCookie?.() ?? []
  const sess = setCookies.find(c => c.startsWith('sess-'))
  const m = sess?.match(/^([^=]+)=([^;]+)/)
  if (!m) {
    throw new Error(
      `POST /auth/login on ${instance} did not return a session cookie (status ${res.status}): ${await res.text()}`
    )
  }
  return { name: m[1], value: m[2] }
}

function isAppInstalled(user: User, slug: string): boolean {
  const apps = stackExec('apps', 'ls', '--domain', user.instance)
  return apps
    .split('\n')
    .some(line => line.trim().split(/\s+/, 1)[0] === slug)
}

interface AppSpec {
  slug: string
  source: string
  label: string
}

const DEFAULT_APPS: AppSpec[] = [
  {
    slug: 'dataproxy',
    source: 'registry://dataproxy/stable',
    label: 'Dataproxy'
  }
]

async function setupUser(
  user: User
): Promise<{ cookieName: string; cookieValue: string }> {
  console.log(`[e2e] Ensuring instance for ${user.label} (${user.instance})...`)
  await createInstance(user)

  for (const app of DEFAULT_APPS) {
    if (isAppInstalled(user, app.slug)) {
      console.log(`[e2e] Reusing ${app.label} app for ${user.label}.`)
    } else {
      console.log(`[e2e] Installing ${app.label} app for ${user.label}...`)
      stackExec(
        'apps',
        'install',
        app.slug,
        app.source,
        '--domain',
        user.instance
      )
    }
  }

  console.log(`[e2e] Setting feature flags for ${user.label}...`)
  setFlags(user.instance, DEFAULT_FLAGS)

  console.log(`[e2e] Getting session cookie for ${user.label}...`)
  const cookie = await getSessionCookie(user)
  return { cookieName: cookie.name, cookieValue: cookie.value }
}

// Pre-populate each instance's address book with a contact for every other
// org member. A deterministic document ID makes this provisioning idempotent.
async function createContact(hostUser: User, peer: User): Promise<void> {
  const token = stackExec(
    'instances',
    'token-cli',
    hostUser.instance,
    'io.cozy.contacts'
  )
  const contactId = `e2e-contact-${hostUser.label}-${peer.label}`
  const res = await fetch(
    `http://${hostUser.instance}/data/io.cozy.contacts/${contactId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fullname: peer.label,
        name: { givenName: peer.label },
        email: [{ address: peer.email, primary: true }],
        cozy: [{ url: `http://${peer.instance}`, primary: true }]
      })
    }
  )
  // A prior persistent run has already created this fixture.
  if (res.status === 409) return
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `Failed to create contact for ${peer.email} on ${hostUser.instance} (${res.status}): ${body}`
    )
  }
}

async function syncContacts(trio: User[]): Promise<void> {
  for (const host of trio) {
    for (const peer of trio) {
      if (peer.instance !== host.instance) {
        await createContact(host, peer)
      }
    }
  }
}

export async function setupStack(
  portsConfig: E2EPortsConfig,
  workers = 1
): Promise<void> {
  // Both Cozy and OnlyOffice must share this ephemeral secret. A fresh
  // value is created per isolated E2E run, never a user or production key.
  if (process.env.COZY_E2E_ONLYOFFICE_JWT_ENABLED === 'true') {
    process.env.COZY_E2E_ONLYOFFICE_JWT_SECRET =
      process.env.COZY_E2E_ONLYOFFICE_JWT_SECRET || randomBytes(32).toString('hex')
  }
  process.env.E2E_PROJECT_NAME = portsConfig.projectName
  process.env.COZY_E2E_ROOT_DOMAIN = portsConfig.rootDomain
  process.env.COZY_E2E_STACK_PORT = String(portsConfig.stackPort)
  process.env.COZY_E2E_ADMIN_PORT = String(portsConfig.adminPort)
  process.env.COZY_E2E_COUCHDB_PORT = String(portsConfig.couchdbPort)
  process.env.COZY_E2E_ONLYOFFICE_PORT = String(portsConfig.onlyofficePort)

  applyConfigUpdate(portsConfig)

  console.log(`[e2e] Runtime environment:`)
  console.log(`  - Project:  ${portsConfig.projectName}`)
  console.log(`  - Domain:   *.${portsConfig.rootDomain}`)
  console.log(`  - Stack:    http://localhost:${portsConfig.stackPort}`)
  console.log(`  - Admin:    http://localhost:${portsConfig.adminPort}`)
  console.log(`  - CouchDB:  http://localhost:${portsConfig.couchdbPort}`)
  console.log(`  - Office:   http://onlyoffice.${portsConfig.rootDomain}:${portsConfig.onlyofficePort}`)

  if (RESET || !PERSIST) {
    console.log(
      RESET
        ? '[e2e] E2E_RESET=1 — explicitly removing this runtime and its data.'
        : '[e2e] Cleaning up previous containers (set E2E_PERSIST=1 to retain them)...'
    )
    compose('down', '--volumes')
  } else {
    console.log('[e2e] Persistent mode — retaining this runtime and its data.')
  }

  // Document Server mounts the folder: it must hold the plugin before it
  // starts, and the plugin of this worktree when a persistent runtime is reused
  console.log('[e2e] Building the scribe plugin of the Document Server...')
  execFileSync('node', ['plugins/onlyoffice-scribe/build.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit'
  })

  console.log('[e2e] Starting Docker containers...')
  compose(
    'up',
    '--detach',
    ...(PERSIST && !RESET ? ['--no-recreate'] : []),
    '--wait',
    '--wait-timeout',
    '330'
  )

  const trios = Array.from({ length: workers }, (_, parallelIndex) =>
    Object.values(
      buildUsers(portsConfig.rootDomain, portsConfig.stackPort, parallelIndex)
    )
  )

  console.log('[e2e] Waiting for cozy-stack...')
  await waitForStack(getStackUrl())
  await verifyOfficeNetwork(portsConfig, trios.flat())

  const results: Array<
    [string, { domain: string; cookieName: string; cookieValue: string }]
  > = []
  for (const user of trios.flat()) {
    const cookie = await setupUser(user)
    results.push([user.instance, { domain: user.instance, ...cookie }])
  }
  saveAuthState(Object.fromEntries(results))

  console.log('[e2e] Cross-populating org contacts...')
  for (const trio of trios) {
    await syncContacts(trio)
  }

  console.log('[e2e] Setup complete.')
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (config.workers > MAX_WORKERS) {
    throw new Error(
      `The E2E suite supports at most ${MAX_WORKERS} workers, got ${config.workers}`
    )
  }
  await withPortAllocationLock(async () => {
    const portsConfig = await resolveE2EPorts()
    await setupStack(portsConfig, config.workers)
  })
}
