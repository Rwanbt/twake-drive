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
  let holdSelection = false
  let resolveSelection
  let failNextCommand = false
  let holdWrite = false
  let resolveWrite
  const priorWritten = []
  let readResult = { content: 'private data', target: 'document', canReplace: true }
  const timers = []
  const host = { postMessage: (message, to) => sent.push({ message, to }) }
  const plugin = {
    info: { editorType: 'word' },
    scope: {},
    callCommand: (command, _a, _b, resolve) => {
      calls.push(command)
      if (command === writeSlideLines) priorWritten.push(window.Asc.scope.written)
      if (failNextCommand) {
        failNextCommand = false
        throw new Error('editor disconnected')
      }
      if (holdWrite && command === writeSlideLines) {
        resolveWrite = resolve
        holdWrite = false
      } else if (holdRead && command === readContent) {
        resolveRead = resolve
      } else {
        resolve(readResult)
      }
    },
    executeMethod: (_name, _args, resolve) => {
      if (holdSelection) {
        holdSelection = false
        resolveSelection = resolve
      } else {
        resolve('')
      }
    }
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
  function readSlideContent() {}
  function writeSlideLines() {}
  function findWrittenParagraphs() {}
  function insertSlide() {}
  runInNewContext(source + '\nwindow.__getCurrentSelection = () => lastSelectedText', {
    window, URL,
    setTimeout: callback => { timers.push(callback); return timers.length },
    clearTimeout: () => {},
    isTrustedHostMessage,
    readContent, writeBlocks, readSlideContent, writeSlideLines,
    findWrittenParagraphs, insertSlide,
    makeBlocks: text => text ? [text] : [],
    makeLineSpans: blocks => blocks,
    makeLines: blocks => blocks
  })
  plugin.init()
  const emitRaw = (sourceWindow, sourceOrigin, type, data = {}) =>
    listener({ source: sourceWindow, origin: sourceOrigin, data: { type, ...data } })
  const emit = (type, data = {}) => emitRaw(host, origin, type, data)
  return {
    calls, sent, emit, emitRaw, readContent, writeBlocks, priorWritten,
    currentSelection: () => window.__getCurrentSelection(),
    setEditorType: type => { plugin.info.editorType = type },
    holdNextWrite: () => { holdWrite = true },
    flushWrite: result => { assert.ok(resolveWrite); resolveWrite(result) },
    holdNextRead: () => { holdRead = true },
    flushRead: () => { assert.ok(resolveRead); holdRead = false; resolveRead(readResult) },
    holdNextSelection: () => { holdSelection = true },
    flushSelection: text => { assert.ok(resolveSelection); resolveSelection(text) },
    setReadResult: result => { readResult = result },
    failNextCommand: () => { failNextCommand = true },
    reinitialize: () => plugin.init(),
    fireSelectionTimer: () => { assert.ok(timers.length); return timers.shift()() }
  }
}

test('same-origin sibling window cannot revive closed Scribe or read after reopen', async () => {
  const app = harness()
  const sibling = { postMessage() { throw new Error('leaked into wrong window') } }
  await app.emit('twake-scribe:getContent')
  await app.emit('twake-scribe:close')
  await app.emitRaw(sibling, origin, 'twake-scribe:getContent')
  await app.emitRaw(sibling, origin, 'twake-scribe:applyAnswer', {
    text: 'foreign write', answerAction: 'insert'
  })
  assert.equal(app.calls.length, 1)
  await app.emit('twake-scribe:getContent')
  await app.emitRaw(sibling, origin, 'twake-scribe:insertSlide', {
    title: 'foreign', bullets: ['foreign']
  })
  assert.equal(app.calls.length, 2, 'another same-origin window must not write in the newly opened panel')
  assert.equal(app.sent.filter(({ message }) => message.type === 'twake-scribe:content').length, 2)
})

test('content responses retain their open request identity across panel sessions', async () => {
  const app = harness()
  await app.emit('twake-scribe:getContent', { requestId: 41 })
  await app.emit('twake-scribe:close')
  await app.emit('twake-scribe:getContent', { requestId: 42 })
  assert.deepEqual(
    app.sent
      .filter(({ message }) => message.type === 'twake-scribe:content')
      .map(({ message }) => message.requestId),
    [41, 42],
    'the host can reject an earlier request after closing and reopening'
  )
})

test('a closed presentation write cannot repopulate the reopened panel state', async () => {
  const app = harness()
  app.setEditorType('slide')
  await app.emit('twake-scribe:getContent')
  app.holdNextWrite()
  const stale = app.emit('twake-scribe:applyAnswer', {
    text: 'old slide answer', answerAction: 'insert'
  })
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  assert.equal(app.priorWritten.length, 1, 'old slide write entered the editor')
  await app.emit('twake-scribe:close')
  const reopened = app.emit('twake-scribe:getContent')
  app.flushWrite({ oldSlide: true })
  await stale
  await reopened
  await app.emit('twake-scribe:applyAnswer', {
    text: 'new slide answer', answerAction: 'insert'
  })
  assert.equal(app.priorWritten.length, 2)
  assert.equal(app.priorWritten[1], null,
    'a completed stale slide write must not become the new panel’s written selection')
})

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

test('temporary OnlyOffice command failure cannot poison all future editor commands', async () => {
  const app = harness()
  app.failNextCommand()
  await assert.rejects(app.emit('twake-scribe:getContent'), /editor disconnected/)
  await app.emit('twake-scribe:getContent')
  assert.equal(app.calls.length, 2, 'a subsequent authorized request must reach the editor')
  assert.equal(app.sent.filter(({ message }) => message.type === 'twake-scribe:content').length, 1)
})

test('queued replacement writes are revoked even if the panel reopens at the same origin', async () => {
  const app = harness()
  app.holdNextRead()
  const first = app.emit('twake-scribe:getContent')
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  const queued = app.emit('twake-scribe:applyAnswer', {
    text: 'must not write from old panel',
    answerAction: 'replace'
  })
  await app.emit('twake-scribe:close')
  app.flushRead()
  await first
  await queued
  await app.emit('twake-scribe:getContent')
  assert.equal(app.calls.filter(command => command === app.writeBlocks).length, 0,
    'no stale write may execute from a closed panel')
  assert.equal(app.sent.filter(({ message }) => message.type === 'twake-scribe:content').length, 1,
    'the newly authorized panel can still read content')
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

test('a delayed selection from a closed panel cannot leak into a reopened panel', async () => {
  const app = harness()
  await app.emit('twake-scribe:getContent')
  app.holdNextSelection()
  app.reinitialize()
  const oldSelection = app.fireSelectionTimer()
  await app.emit('twake-scribe:close')
  await app.emit('twake-scribe:getContent')
  app.setReadResult({ content: 'different private selection', target: 'selection', canReplace: true })
  app.flushSelection('old selection text')
  await oldSelection
  assert.equal(app.sent.filter(({ message }) => message.type === 'twake-scribe:selection').length, 0,
    'the previous panel must not publish a selection to the new panel')
})

test('reopened panel can write while stale prior-panel selection is still pending', async () => {
  const app = harness()
  await app.emit('twake-scribe:getContent')
  app.holdNextSelection()
  const stale = app.emit('twake-scribe:applyAnswer', {
    text: 'first panel answer', answerAction: 'insert'
  })
  // Let the first write finish in the editor, but keep its follow-up
  // GetSelectedText request suspended while a new panel becomes active.
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  assert.equal(app.calls.filter(command => command === app.writeBlocks).length, 1)
  await app.emit('twake-scribe:close')
  await app.emit('twake-scribe:getContent')
  await app.emit('twake-scribe:applyAnswer', {
    text: 'new authorized answer', answerAction: 'insert'
  })
  assert.equal(app.calls.filter(command => command === app.writeBlocks).length, 2,
    'a stale pending selection must not block a new authorized write')
  app.flushSelection('old result')
  await stale
})

test('a closed answer cannot overwrite selection state after a new panel opens', async () => {
  const app = harness()
  await app.emit('twake-scribe:getContent')
  app.holdNextSelection()
  const oldAnswer = app.emit('twake-scribe:applyAnswer', { text: 'old text', answerAction: 'insert' })
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  await app.emit('twake-scribe:close')
  await app.emit('twake-scribe:getContent')
  assert.equal(app.currentSelection(), '')
  app.flushSelection('old panel selection')
  await oldAnswer
  assert.equal(app.currentSelection(), '', 'stale selection must not contaminate new panel')
})
