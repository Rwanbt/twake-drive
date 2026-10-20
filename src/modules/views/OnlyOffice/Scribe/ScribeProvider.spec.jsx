import { act, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'

import logger from '@/lib/logger'
import {
  ScribeProvider,
  useScribe
} from '@/modules/views/OnlyOffice/Scribe/ScribeProvider'

jest.mock('@/lib/logger', () => ({ warn: jest.fn() }))

const SERVER_URL = 'https://onlyoffice.example.org/'
const SERVER_ORIGIN = 'https://onlyoffice.example.org'

const SLIDE = {
  capability: 'insert_slide',
  params: {
    title: 'Budget',
    bullets: ['Dépenses', '- Recettes', '']
  }
}
const TABLE = {
  capability: 'insert_table',
  params: {
    caption: 'Budget des lots',
    columns: ['Lot', 'Budget'],
    rows: ['Atlas | 42 000 €', 'Borée | 12 000 €', '']
  }
}

const ScribeState = ({ results = [], capture }) => {
  const {
    isAvailable,
    isOpen,
    content,
    target,
    canReplace,
    open,
    close,
    applyResult
  } = useScribe()
  capture?.({ close, applyResult })

  return (
    <>
      <output data-testid="state">
        {JSON.stringify({ isAvailable, isOpen, content, target, canReplace })}
      </output>
      <button onClick={open}>open</button>
      <button onClick={close}>close</button>
      <button
        onClick={() =>
          applyResult({
            answerAction: 'replace',
            text: 'Bonjour',
            format: 'markdown'
          })
        }
      >
        apply
      </button>
      {results.map((result, index) => (
        <button key={index} onClick={() => applyResult(result)}>
          {`result ${index}`}
        </button>
      ))}
    </>
  )
}

const setup = ({ documentType = 'word', results } = {}) => {
  let callbacks = null
  const editorFrame = document.createElement('iframe')
  editorFrame.name = 'frameEditor'
  document.body.appendChild(editorFrame)
  const pluginFrame = editorFrame.contentDocument.createElement('iframe')
  editorFrame.contentDocument.body.appendChild(pluginFrame)
  const plugin = pluginFrame.contentWindow
  Object.defineProperty(plugin, 'postMessage', {
    configurable: true,
    value: jest.fn()
  })
  const receive = (data, { origin = SERVER_ORIGIN, source = plugin } = {}) => {
    act(() => {
      const event = new MessageEvent('message', { data, origin })
      // jsdom only takes a real window as the source of a MessageEvent
      Object.defineProperty(event, 'source', { value: source })
      window.dispatchEvent(event)
    })
  }
  const openRequestId = () =>
    plugin.postMessage.mock.calls
      .filter(([message]) => message.type === 'twake-scribe:getContent')
      .slice(-1)[0]?.[0].requestId
  const receiveContent = data =>
    receive({ ...data, requestId: openRequestId() })
  const openPanel = () => {
    fireEvent.click(screen.getByText('open'))
    receiveContent({
      type: 'twake-scribe:content',
      content: 'editor document',
      target: 'document'
    })
    plugin.postMessage.mockClear()
  }

  const renderResult = render(
    <ScribeProvider serverUrl={SERVER_URL} documentType={documentType}>
      <ScribeState
        results={results}
        capture={value => {
          callbacks = value
        }}
      />
    </ScribeProvider>
  )

  const getState = () => JSON.parse(screen.getByTestId('state').textContent)

  return {
    plugin,
    receive,
    receiveContent,
    openPanel,
    openRequestId,
    getState,
    changeServer: serverUrl =>
      renderResult.rerender(
        <ScribeProvider serverUrl={serverUrl} documentType={documentType}>
          <ScribeState
            results={results}
            capture={value => {
              callbacks = value
            }}
          />
        </ScribeProvider>
      ),
    getCallbacks: () => callbacks
  }
}

describe('ScribeProvider', () => {
  afterEach(() => {
    document
      .querySelectorAll(
        'iframe[name="frameEditor"], iframe[data-scribe-sibling]'
      )
      .forEach(frame => frame.remove())
  })

  it('has no scribe until the plugin of the Document Server is ready', () => {
    const { receive, getState } = setup()

    expect(getState()).toEqual({ isAvailable: false, isOpen: false })

    receive({ type: 'twake-scribe:ready' })

    expect(getState()).toEqual({ isAvailable: true, isOpen: false })
  })

  it('drops the previous document and plugin when the Document Server origin changes', () => {
    const { plugin, receive, openPanel, getState, changeServer } = setup()
    receive({ type: 'twake-scribe:ready' })
    openPanel()
    expect(getState().content).toBe('editor document')

    changeServer('https://other-office.example.org/')
    expect(getState()).toEqual({ isAvailable: false, isOpen: false })
    expect(plugin.postMessage).toHaveBeenCalledWith(
      { type: 'twake-scribe:close' },
      SERVER_ORIGIN
    )
    receive({ type: 'twake-scribe:ready' })
    expect(getState().isAvailable).toBe(false)
  })

  it('ignores the messages that do not come from the Document Server', () => {
    const { receive, getState } = setup()

    receive({ type: 'twake-scribe:ready' }, { origin: 'https://example.org' })
    receive('a text', { origin: SERVER_ORIGIN })

    expect(getState().isAvailable).toBe(false)
  })

  it('rejects a spoofed ready from a same-origin frame outside the document editor', () => {
    const { plugin, receive, openRequestId, getState } = setup()
    const sibling = document.createElement('iframe')
    sibling.dataset.scribeSibling = 'true'
    document.body.appendChild(sibling)
    receive({ type: 'twake-scribe:ready' }, { source: sibling.contentWindow })
    expect(getState().isAvailable).toBe(false)

    receive({ type: 'twake-scribe:ready' })
    expect(getState().isAvailable).toBe(true)
    fireEvent.click(screen.getByText('open'))
    expect(plugin.postMessage).toHaveBeenCalledWith(
      { type: 'twake-scribe:getContent', requestId: openRequestId() },
      SERVER_ORIGIN
    )
    sibling.remove()
  })

  it('rejects forged content from the same server origin and keeps the current editor', () => {
    const { receive, receiveContent, getState } = setup()
    receive({ type: 'twake-scribe:ready' })
    const sibling = document.createElement('iframe')
    sibling.dataset.scribeSibling = 'true'
    document.body.appendChild(sibling)
    receive(
      { type: 'twake-scribe:content', content: 'spoof', target: 'document' },
      { source: sibling.contentWindow }
    )
    expect(getState().isOpen).toBe(false)
    fireEvent.click(screen.getByText('open'))
    receiveContent({
      type: 'twake-scribe:content',
      content: 'genuine',
      target: 'document'
    })
    expect(getState().content).toBe('genuine')
    sibling.remove()
  })

  it('asks the plugin for the text, and opens when it comes', () => {
    const { plugin, receive, receiveContent, openRequestId, getState } = setup()
    receive({ type: 'twake-scribe:ready' })

    fireEvent.click(screen.getByText('open'))

    expect(plugin.postMessage).toHaveBeenCalledWith(
      { type: 'twake-scribe:getContent', requestId: openRequestId() },
      SERVER_ORIGIN
    )
    expect(getState().isOpen).toBe(false)

    receiveContent({
      type: 'twake-scribe:content',
      content: 'Un **texte**',
      target: 'selection',
      canReplace: true
    })

    expect(getState()).toEqual({
      isAvailable: true,
      isOpen: true,
      content: 'Un **texte**',
      target: 'selection',
      canReplace: true
    })
  })

  it('works on another text selected while it is open, and not when closed', () => {
    const { receive, receiveContent, getState } = setup()
    receive({ type: 'twake-scribe:ready' })
    receive({
      type: 'twake-scribe:selection',
      content: 'Avant',
      target: 'selection'
    })
    expect(getState().isOpen).toBe(false)

    fireEvent.click(screen.getByText('open'))
    receiveContent({
      type: 'twake-scribe:content',
      content: '',
      target: 'document'
    })
    receive({
      type: 'twake-scribe:selection',
      content: 'Autre',
      target: 'selection',
      canReplace: false
    })

    expect(getState()).toEqual({
      isAvailable: true,
      isOpen: true,
      content: 'Autre',
      target: 'selection',
      canReplace: false
    })
  })

  it('closes, and tells the plugin to stop reading the selection', () => {
    const { plugin, receive, receiveContent, getState } = setup()
    receive({ type: 'twake-scribe:ready' })
    fireEvent.click(screen.getByText('open'))
    receiveContent({
      type: 'twake-scribe:content',
      content: '',
      target: 'document'
    })
    expect(getState().isOpen).toBe(true)

    fireEvent.click(screen.getByText('close'))

    expect(getState()).toEqual({ isAvailable: true, isOpen: false })
    expect(plugin.postMessage).toHaveBeenCalledWith(
      { type: 'twake-scribe:close' },
      SERVER_ORIGIN
    )
  })

  it('does not reopen from an unsolicited or delayed reply after close', () => {
    const { receive, openRequestId, getState } = setup()
    receive({ type: 'twake-scribe:ready' })
    receive({
      type: 'twake-scribe:content',
      content: 'unsolicited',
      target: 'document'
    })
    expect(getState().isOpen).toBe(false)

    fireEvent.click(screen.getByText('open'))
    const oldRequestId = openRequestId()
    fireEvent.click(screen.getByText('close'))
    receive({
      type: 'twake-scribe:content',
      content: 'late',
      target: 'document',
      requestId: oldRequestId
    })
    expect(getState().isOpen).toBe(false)

    fireEvent.click(screen.getByText('open'))
    const newRequestId = openRequestId()
    expect(newRequestId).not.toBe(oldRequestId)
    receive({
      type: 'twake-scribe:content',
      content: 'late after reopen',
      target: 'document',
      requestId: oldRequestId
    })
    expect(getState().isOpen).toBe(false)
    receive({
      type: 'twake-scribe:content',
      content: 'current',
      target: 'document',
      requestId: newRequestId
    })
    expect(getState().content).toBe('current')
  })

  it('ignores late cancel and result handlers from a previously closed assistant panel', () => {
    const { plugin, receive, receiveContent, getState, getCallbacks } = setup()
    receive({ type: 'twake-scribe:ready' })
    fireEvent.click(screen.getByText('open'))
    receiveContent({
      type: 'twake-scribe:content',
      content: 'first document',
      target: 'document'
    })
    const previousPanel = getCallbacks()

    fireEvent.click(screen.getByText('close'))
    fireEvent.click(screen.getByText('open'))
    receiveContent({
      type: 'twake-scribe:content',
      content: 'new document',
      target: 'document'
    })
    const callsBeforeOldResult = plugin.postMessage.mock.calls.length
    act(() =>
      previousPanel.applyResult({ answerAction: 'insert', text: 'stale' })
    )
    expect(plugin.postMessage).toHaveBeenCalledTimes(callsBeforeOldResult)
    act(() => previousPanel.close())
    expect(getState().content).toBe('new document')
    expect(getState().isOpen).toBe(true)
  })

  it('hands an answer of the assistant to the plugin as it is', () => {
    const { plugin, receive, openPanel } = setup()
    receive({ type: 'twake-scribe:ready' })
    openPanel()

    fireEvent.click(screen.getByText('apply'))

    expect(plugin.postMessage).toHaveBeenCalledWith(
      {
        type: 'twake-scribe:applyAnswer',
        answerAction: 'replace',
        text: 'Bonjour',
        format: 'markdown'
      },
      SERVER_ORIGIN
    )
  })

  it('asks the plugin to add the slide the assistant has made, in a presentation', () => {
    const { plugin, receive, openPanel } = setup({
      documentType: 'slide',
      results: [SLIDE]
    })
    receive({ type: 'twake-scribe:ready' })
    openPanel()

    fireEvent.click(screen.getByText('result 0'))

    expect(plugin.postMessage).toHaveBeenCalledWith(
      {
        type: 'twake-scribe:insertSlide',
        title: 'Budget',
        bullets: ['Dépenses', 'Recettes']
      },
      SERVER_ORIGIN
    )
  })

  it('ignores an unknown capability, wrong parameters, and a slide outside of a presentation', () => {
    const results = [
      { capability: 'delete_slide', params: {} },
      { capability: 'insert_slide', params: { title: 'Budget' } },
      { capability: 'insert_slide', params: { title: '', bullets: [] } },
      { capability: 'insert_slide', params: null }
    ]
    const { plugin, receive, openPanel } = setup({
      documentType: 'slide',
      results
    })
    receive({ type: 'twake-scribe:ready' })
    openPanel()

    results.forEach((_, index) =>
      fireEvent.click(screen.getByText(`result ${index}`))
    )

    expect(plugin.postMessage).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(results.length)
  })

  it('does not disclose rejected assistant capability parameters to logs', () => {
    const confidential = 'confidential-document-content-example-1034'
    const { receive, openPanel } = setup({
      results: [
        {
          capability: 'unknown_' + confidential,
          params: { documentText: confidential, accessToken: confidential }
        }
      ]
    })
    receive({ type: 'twake-scribe:ready' })
    openPanel()

    fireEvent.click(screen.getByText('result 0'))

    expect(logger.warn).toHaveBeenCalledWith(
      'Scribe: unsupported or invalid capability ignored'
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(confidential)
  })

  it('adds no slide to a text document', () => {
    const { plugin, receive, openPanel } = setup({ results: [SLIDE] })
    receive({ type: 'twake-scribe:ready' })
    openPanel()

    fireEvent.click(screen.getByText('result 0'))

    expect(plugin.postMessage).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('writes the table the assistant has made in a text document, as a Markdown answer', () => {
    const { plugin, receive, openPanel } = setup({ results: [TABLE] })
    receive({ type: 'twake-scribe:ready' })
    openPanel()

    fireEvent.click(screen.getByText('result 0'))

    expect(plugin.postMessage).toHaveBeenCalledWith(
      {
        type: 'twake-scribe:applyAnswer',
        answerAction: 'insert',
        text: 'Budget des lots\n\n| Lot | Budget |\n| --- | --- |\n| Atlas | 42 000 € |\n| Borée | 12 000 € |',
        format: 'markdown'
      },
      SERVER_ORIGIN
    )
  })

  it('ignores a table with wrong parameters, or outside of a text document', () => {
    const results = [
      { capability: 'insert_table', params: { columns: ['Lot'] } },
      { capability: 'insert_table', params: { columns: [], rows: ['Atlas'] } },
      { capability: 'insert_table', params: null }
    ]
    const { plugin, receive, openPanel } = setup({ results })
    receive({ type: 'twake-scribe:ready' })
    openPanel()

    results.forEach((_, index) =>
      fireEvent.click(screen.getByText(`result ${index}`))
    )

    expect(plugin.postMessage).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(results.length)
  })

  it('adds no table to a presentation', () => {
    const { plugin, receive, openPanel } = setup({
      documentType: 'slide',
      results: [TABLE]
    })
    receive({ type: 'twake-scribe:ready' })
    openPanel()

    fireEvent.click(screen.getByText('result 0'))

    expect(plugin.postMessage).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
