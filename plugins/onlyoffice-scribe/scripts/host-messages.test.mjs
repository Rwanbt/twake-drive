import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isTrustedHostMessage } from './host-messages.mjs'

const appWindow = {}
const origin = 'https://drive.example.org'

test('only the original app window at its exact document origin can request writes', () => {
  assert.equal(
    isTrustedHostMessage({ source: appWindow, origin }, appWindow, origin),
    true
  )

  for (const hostileOrigin of [
    'https://drive.example.org.attacker.test',
    'https://evil.example.org',
    'http://drive.example.org',
    'null',
    ''
  ]) {
    assert.equal(
      isTrustedHostMessage(
        { source: appWindow, origin: hostileOrigin },
        appWindow,
        origin
      ),
      false,
      `must reject navigated origin: ${hostileOrigin}`
    )
  }
})

test('forged frames, missing origin and malformed events fail closed', () => {
  assert.equal(
    isTrustedHostMessage({ source: {}, origin }, appWindow, origin),
    false
  )
  assert.equal(
    isTrustedHostMessage({ source: appWindow, origin }, appWindow, null),
    false
  )
  assert.equal(
    isTrustedHostMessage({ source: appWindow, origin }, appWindow, ''),
    false
  )
  assert.equal(isTrustedHostMessage(null, appWindow, origin), false)
  assert.equal(isTrustedHostMessage({}, appWindow, origin), false)
})

test('the actual Scribe listener refuses cross-origin reads and writes', async () => {
  const sent = []
  let onMessage
  let editorCalls = 0
  const host = {
    postMessage: (message, targetOrigin) => sent.push({ message, targetOrigin })
  }
  const plugin = {
    info: { editorType: 'word' },
    callCommand: (_command, _unused, _recalculated, resolve) => {
      editorCalls += 1
      resolve({ content: 'private document', target: 'document' })
    },
    executeMethod: (_name, _args, resolve) => resolve('')
  }
  globalThis.window = {
    parent: {
      parent: host,
      location: {
        href: 'https://editor.example.org/?parentOrigin=https%3A%2F%2Fdrive.example.org'
      },
      document: { addEventListener: () => {} }
    },
    Asc: { plugin, scope: {} },
    addEventListener: (type, callback) => {
      if (type === 'message') onMessage = callback
    }
  }
  try {
    // Execute the unchanged plugin body with OnlyOffice's editor functions
    // stubbed out. This test needs no browser, npm install, or external server.
    const source = readFileSync(new URL('./scribe.js', import.meta.url), 'utf8')
      .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, '')
    runInNewContext(source, {
      window: globalThis.window,
      URL,
      isTrustedHostMessage,
      readContent: () => undefined,
      setTimeout,
      clearTimeout
    })
    plugin.init()
    assert.equal(sent.length, 1)
    // vm-created objects have a different prototype; verify the wire fields.
    assert.equal(sent[0].message.type, 'twake-scribe:ready')
    assert.equal(sent[0].targetOrigin, origin)

    await onMessage({
      source: host,
      origin: 'https://attacker.example',
      data: { type: 'twake-scribe:getContent' }
    })
    await onMessage({
      source: host,
      origin: 'https://attacker.example',
      data: { type: 'twake-scribe:applyAnswer', text: 'malicious', answerAction: 'insert' }
    })
    await onMessage({
      source: {},
      origin,
      data: { type: 'twake-scribe:getContent' }
    })
    assert.equal(editorCalls, 0, 'untrusted messages must never reach editor API')
    assert.equal(sent.length, 1, 'no document bytes may escape to an untrusted source')

    await onMessage({
      source: host,
      origin,
      data: { type: 'twake-scribe:getContent' }
    })
    assert.equal(editorCalls, 1)
    assert.equal(sent[1].targetOrigin, origin)
    assert.equal(sent[1].message.content, 'private document')
  } finally {
    delete globalThis.window
  }
})
