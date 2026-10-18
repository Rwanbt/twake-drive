import { readContent, writeBlocks } from './document.js'
import { isTrustedHostMessage } from './host-messages.js'
import { makeBlocks, makeLineSpans, makeLines } from './markdown.js'
import {
  findWrittenParagraphs,
  insertSlide,
  readSlideContent,
  writeSlideLines
} from './presentation.js'

// The plugin is in the frame of the editor, itself in the app that shows it
const host = window.parent.parent
// Time for a selection to settle before it is read: a selection made with
// the mouse or the keyboard changes many times
const SELECTION_DELAY = 400
// A selection is read with callCommand, which empties the redo of the editor.
// An undo or a redo changes the selection: none is read for this time after
// one, long enough for the throttled timers of a background frame.
const UNDO_REDO_PAUSE = 3000
// The paragraphs of the last answer written in a presentation
let written = null
// The origin of the app while its panel is open: it has asked for the text
let hostOrigin = null
// Stable origin granted by the editor frame, not learned from incoming traffic.
let expectedHostOrigin = null
// The text last given to the app, its plain text, and whether an answer is
// being written
let lastContent = null
let lastSelectedText = null
// An editor result may still be awaiting GetSelectedText after its panel is
// closed. Only a write from the current panel may block new writes/selection;
// a stale result must neither lock a reopened panel nor release its lock.
let writingRequest = null
let selectionTimer = null
let pausedUntil = 0
let isStarted = false
// Each request for the text, and each close of the panel, ends the requests
// still being read: the panel does not open again for an older one
let contentRequest = 0
// The editor keeps a single callback of the plugin for its commands: a
// command sent while another one runs would take its result, and the other
// one would never end. They run one after the other.
let lastCommand = Promise.resolve()

function runInEditor(
  command,
  { scope = {}, isRecalculated = false, canRun = null } = {}
) {
  const run = lastCommand.then(() => {
    // A command can wait behind another editor command. The panel may have
    // closed or started another request while it was in that queue.
    if (canRun && !canRun()) return null
    return new Promise(resolve => {
      // The scope goes with the command when it is sent
      Object.assign(window.Asc.scope, scope)
      window.Asc.plugin.callCommand(command, false, isRecalculated, resolve)
    })
  })
  // An editor command may throw after OnlyOffice destroys/recreates its
  // plugin instance. Reject that request, but do not poison the serialized
  // queue forever: a later authorized panel must be able to retry.
  lastCommand = run.catch(() => null)
  return run
}

function callEditor(method, parameters) {
  return new Promise(resolve => {
    window.Asc.plugin.executeMethod(method, parameters, resolve)
  })
}

function isPresentation() {
  return window.Asc.plugin.info.editorType === 'slide'
}

// The editor gives the selected text of a presentation to the plugin only,
// not to the code it runs
function fetchSelectedText() {
  return callEditor('GetSelectedText', [{ ParaSeparator: '\n' }])
}

async function readPresentation() {
  const selectedText = await fetchSelectedText()
  return runInEditor(readSlideContent, { scope: { selectedText } })
}

async function writePresentation(text, isReplace, canWrite) {
  // A line of the answer is a paragraph of the slide
  const blocks = makeBlocks(text, { hasLineBreaks: true })
  const lineSpans = makeLineSpans(blocks)
  if (lineSpans.length === 0) return

  const selectedText = await fetchSelectedText()
  if (!canWrite()) return
  const result = await runInEditor(writeSlideLines, {
    scope: { lineSpans, isReplace, selectedText, written },
    isRecalculated: true,
    canRun: canWrite
  })
  if (result?.isInline && canWrite()) {
    // The editor writes plain text, in the look of the text around it
    const lines = makeLines(blocks)
    await callEditor('ReplaceTextSmart', [lines])
    if (!canWrite()) return
    written = await runInEditor(findWrittenParagraphs, {
      scope: { count: lines.length },
      canRun: canWrite
    })
    return
  }
  written = result
}

function fetchContent() {
  return isPresentation() ? readPresentation() : runInEditor(readContent)
}

// The editor runs no command while it loads or saves: the text is then not
// read, and the app asks again
async function sendContent(origin) {
  contentRequest += 1
  const request = contentRequest
  const read = await fetchContent()
  const selectedText = await fetchSelectedText()
  if (!read || request !== contentRequest) return
  hostOrigin = origin
  lastContent = read.content
  lastSelectedText = selectedText

  host.postMessage({ type: 'twake-scribe:content', ...read }, origin)
}

// Another text selected: the app gives it to the assistant if it is open.
// A cursor that moves, or the text of an answer just written, is not another
// text.
// The selection is read by a command only when its text changes: a command
// empties the redo of the editor.
async function sendSelection() {
  if (!hostOrigin || writingRequest === contentRequest || Date.now() < pausedUntil) return
  // A close/reopen may retain the same host origin. Keep the request epoch too,
  // otherwise a delayed selection from the previous panel can reach the new one.
  const request = contentRequest
  const origin = hostOrigin
  const selectedText = await fetchSelectedText()
  // The panel may have been closed while the selection was read
  if (
    request !== contentRequest ||
    hostOrigin !== origin ||
    !selectedText?.trim()
  )
    return
  if (selectedText === lastSelectedText) return

  const { content, target, canReplace } = (await fetchContent()) ?? {}
  if (
    request !== contentRequest ||
    hostOrigin !== origin ||
    target !== 'selection' ||
    content === lastContent
  )
    return
  lastContent = content
  lastSelectedText = selectedText
  // The answer last written in a presentation is no more the selection
  written = null

  host.postMessage(
    { type: 'twake-scribe:selection', content, target, canReplace },
    origin
  )
}

function handleSelectionChange() {
  clearTimeout(selectionTimer)
  selectionTimer = setTimeout(sendSelection, SELECTION_DELAY)
}

// A read already planned would come after the undo or the redo: it is dropped
function pauseSelection() {
  pausedUntil = Date.now() + UNDO_REDO_PAUSE
  clearTimeout(selectionTimer)
}

// Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo (Cmd on a Mac)
function handleUndoRedoKey(event) {
  if (!event.ctrlKey && !event.metaKey) return
  if (['z', 'y'].includes(event.key?.toLowerCase())) pauseSelection()
}

function handleUndoRedoClick(event) {
  if (event.target?.closest?.('[id*="btn-undo"], [id*="btn-redo"]')) {
    pauseSelection()
  }
}

// The frame of the plugin has the origin of the editor: it hears the keys of
// the editor and the clicks on its toolbar
function watchUndoRedo() {
  try {
    window.parent.document.addEventListener('keydown', handleUndoRedoKey, true)
    window.parent.document.addEventListener('click', handleUndoRedoClick, true)
  } catch {
    document.addEventListener('keydown', handleUndoRedoKey, true)
  }
}

async function writeAnswer({ answerAction, text }, canWrite) {
  // A text that holds what an answer cannot give back, as an image or a
  // note, is never replaced, even when the app asks: the answer goes under
  // it, as when the editor was too busy to read the selection
  const read = answerAction === 'replace' ? await fetchContent() : null
  if (!canWrite()) return
  const isReplace = Boolean(read) && read.canReplace !== false
  if (isPresentation()) {
    await writePresentation(text, isReplace, canWrite)
    return
  }
  const blocks = makeBlocks(text)
  if (blocks.length === 0) return

  await runInEditor(writeBlocks, {
    scope: { blocks, isReplace },
    isRecalculated: true,
    canRun: canWrite
  })
}

async function applyAnswer(answer, request) {
  const canWrite = () => hostOrigin !== null && request === contentRequest
  writingRequest = request
  try {
    await writeAnswer(answer, canWrite)
    if (!canWrite()) return
    // The answer is left selected: it is not another text to work on
    const selectedText = await fetchSelectedText()
    if (selectedText?.trim()) {
      lastContent = (await fetchContent())?.content ?? lastContent
      lastSelectedText = selectedText
    }
  } finally {
    if (writingRequest === request) writingRequest = null
  }
}

// A slide the assistant has made, added after the current one. The app has
// checked it already: this only keeps a wrong message out of the editor.
async function addSlide({ title, bullets }, request) {
  const isSlide =
    typeof title === 'string' &&
    Array.isArray(bullets) &&
    bullets.every(bullet => typeof bullet === 'string')
  if (!isPresentation() || !isSlide || !hostOrigin) return

  writingRequest = request
  try {
    await runInEditor(insertSlide, {
      scope: { title, bullets },
      isRecalculated: true,
      canRun: () => hostOrigin !== null && request === contentRequest
    })
    // The paragraphs of the last answer are on another slide now
    written = null
  } finally {
    if (writingRequest === request) writingRequest = null
  }
}

async function handleMessage(event) {
  // A navigated host window has the same WindowProxy but a different origin.
  if (!isTrustedHostMessage(event, host, expectedHostOrigin)) return

  if (event.data?.type === 'twake-scribe:getContent') {
    await sendContent(event.origin)
  }
  // The panel is closed: the selection is no more read, and the next panel
  // starts on the text then selected, not on the answer last written in a
  // presentation
  if (event.data?.type === 'twake-scribe:close') {
    contentRequest += 1
    hostOrigin = null
    written = null
    clearTimeout(selectionTimer)
  }
  // Writes require an open, current panel, not merely a trusted WindowProxy.
  if (hostOrigin !== event.origin || writingRequest === contentRequest) return
  if (
    event.data?.type === 'twake-scribe:applyAnswer' &&
    typeof event.data.text === 'string'
  ) {
    await applyAnswer(event.data, contentRequest)
  }
  if (event.data?.type === 'twake-scribe:insertSlide') {
    await addSlide(event.data, contentRequest)
  }
}

// The api.js of the Document Server gives the editor the origin of the app
// that shows it, in the address of its frame
function findHostOrigin() {
  try {
    const parentOrigin = new URL(window.parent.location.href).searchParams.get(
      'parentOrigin'
    )
    const { protocol, origin } = new URL(parentOrigin)
    return ['https:', 'http:'].includes(protocol) ? origin : null
  } catch {
    return null
  }
}

// The editor starts the plugin again each time the selection changes
window.Asc.plugin.init = () => {
  if (isStarted) {
    handleSelectionChange()
    return
  }
  isStarted = true
  expectedHostOrigin = findHostOrigin()
  // Without an independently supplied origin, no listener may accept writes.
  if (!expectedHostOrigin) return
  window.addEventListener('message', handleMessage)
  watchUndoRedo()
  host.postMessage({ type: 'twake-scribe:ready' }, expectedHostOrigin)
}
