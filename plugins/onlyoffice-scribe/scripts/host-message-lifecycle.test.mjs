import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isTrustedHostMessage } from './host-messages.js'

const origin = 'https://drive.example.org'
const source = readFileSync(new URL('./scribe.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, '')

function harness() {
  const sent = []
  const calls = []
  let listener
  let holdRead = false
  let resolveRead
  const host = { postMessage: (message, to) => sent.push({ message, to }) }
  const plugin = {
    info: { editorType: 'word' },
    scope: {},
    callCommand: (command, _a, _b, resolve) => {
      calls.push(command)
      if (holdRead && command === readContent) {
        resolveRead = resolve
      } else {
        resolve({ content: 'private data', target: 'document', canReplace: true })
      }
    },
    executeMethod: (_name, _args, resolve) => resolve('')
  }
  const window = {
    parent: {
      parent: host,
      location: { href: 'https://office.example.org/?parentOrigin=' + encodeURIComponent(origin) },
      document: { addEventListener() {} }
    },
    Asc: { plugin, scope: {} },
    addEventListener: (_name, fn) => { listener = fn }
  }
  function readContent() {}
  function writeBlocks() {}
  runInNewContext(source, {
    window, URL, setTimeout, clearTimeout, isTrustedHostMessage,
    readContent, writeBlocks, makeBlocks: text => text ? [text] : []
  })
  plugin.init()
  const emit = (type, data = {}) => listener({ source: host, origin, data: { type, ...data } })
  return {
    calls, sent, emit, readContent, writeBlocks,
    holdNextRead: () => { holdRead = true },
    flushRead: () => { assert.ok(resolveRead); resolveRead({ content: 'private data', target: 'document', canReplace: true }) }
  }
}

test('unopened and closed panels reject delayed answer and slide writes', async () => {
  const app = harness()
  await app.emit('twake-scribe:applyAnswer', { text: 'surprise', answerAction: 'insert' })
  assert.equal(app.calls.length, 0, 'a host window without an open Scribe panel is not authorization')
  await app.emit('twake-scribe:getContent')
  assert.equal(app.calls.length, 1)
  await app.emit('twake-scribe:close')
  await app.emit('twake-scribe:applyAnswer', { text: 'stale answer', answerAction: 'insert' })
  await app.emit('twake-scribe:insertSlide', { title: 'stale', bullets: ['stale'] })
  assert.equal(app.calls.length, 1, 'closing the panel must revoke queued writes')
})

test('closing panel while replacement reads old document drops eventual write', async () => {
  const app = harness()
  await app.emit('twake-scribe:getContent')
  app.holdNextRead()
  const inFlight = app.emit('twake-scribe:applyAnswer', {
    text: 'unauthorized late answer', answerAction: 'replace'
  })
  // Promise continuation enters the delayed read command.
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(app.calls.length, 2)
  await app.emit('twake-scribe:close')
  app.flushRead()
  await inFlight
  assert.deepEqual(app.calls, [app.readContent, app.readContent],
    'the replacement write must not execute once its panel has closed')
})

test('closing panel during asynchronous content read cannot reveal document contents', async () => {
  const app = harness()
  app.holdNextRead()
  const pending = app.emit('twake-scribe:getContent')
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(app.calls.length, 1)
  await app.emit('twake-scribe:close')
  app.flushRead()
  await pending
  assert.equal(app.sent.length, 1, 'only initial ready notification may be sent')
  assert.equal(app.sent[0].message.type, 'twake-scribe:ready')
  await app.emit('twake-scribe:applyAnswer', { text: 'late write', answerAction: 'insert' })
  assert.equal(app.calls.length, 1, 'a stale read must not reopen the closed panel')
})

test('authorized open panel can apply a valid answer', async () => {
  const app = harness()
  await app.emit('twake-scribe:getContent')
  await app.emit('twake-scribe:applyAnswer', { text: 'answer', answerAction: 'insert' })
  assert.ok(app.calls.includes(app.writeBlocks), 'valid write must remain functional')
})
