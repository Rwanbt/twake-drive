import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import logger from '@/lib/logger'
import {
  INSERT_SLIDE,
  INSERT_TABLE,
  makeTableMarkdown,
  normalizeSlide,
  normalizeTable
} from '@/modules/views/OnlyOffice/Scribe/capabilities'
import { FRAME_EDITOR_NAME } from '@/modules/views/OnlyOffice/config'

const ScribeContext = createContext({ isAvailable: false, isOpen: false })

export const useScribe = () => useContext(ScribeContext)

/**
 * Talks to the scribe plugin of the Document Server (plugins/onlyoffice-scribe)
 * through postMessage. Without the plugin, there is no scribe.
 */
export const ScribeProvider = ({ serverUrl, documentType, children }) => {
  const serverOrigin = new URL(serverUrl).origin
  const [plugin, setPlugin] = useState(null)
  const [text, setText] = useState(null)
  const pluginSource = useRef(null)
  const requestSequence = useRef(0)
  const pendingContentRequest = useRef(null)
  const activePanelRequest = useRef(null)

  useEffect(() => {
    const handleMessage = event => {
      if (event.origin !== serverOrigin) return

      const { type, content, target, canReplace, requestId } = event.data ?? {}
      if (type === 'twake-scribe:ready') {
        // The plugin is nested directly inside the Document Server editor.
        // Another frame on the same origin must not impersonate that plugin.
        const editor = document.getElementsByName(FRAME_EDITOR_NAME)[0]
        if (
          !editor?.contentWindow ||
          event.source?.parent !== editor.contentWindow
        )
          return
        pluginSource.current = event.source
        pendingContentRequest.current = null
        activePanelRequest.current = null
        setPlugin(event.source)
        setText(null)
        return
      }

      if (event.source !== pluginSource.current || !pluginSource.current) return
      const text = { content, target, canReplace }
      if (type === 'twake-scribe:content') {
        // The reply must belong to an explicit open of this panel. A response
        // queued before close must not reopen it or replace a newer selection.
        if (pendingContentRequest.current !== requestId || requestId == null)
          return
        pendingContentRequest.current = null
        activePanelRequest.current = requestId
        setText(text)
      }
      if (type === 'twake-scribe:selection') {
        setText(current => (current === null ? null : text))
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [serverOrigin])

  const value = useMemo(() => {
    const sessionId = activePanelRequest.current
    const isCurrentPanel = () =>
      sessionId !== null && activePanelRequest.current === sessionId
    // The plugin has no message for a table: it goes in as a Markdown
    // answer, whose tables the plugin writes as tables of the document
    const makeCapabilityMessage = ({ capability, params }) => {
      if (capability === INSERT_SLIDE && documentType === 'slide') {
        const slide = normalizeSlide(params)
        return slide === null
          ? null
          : { type: 'twake-scribe:insertSlide', ...slide }
      }
      if (capability === INSERT_TABLE && documentType === 'word') {
        const table = normalizeTable(params)
        return table === null
          ? null
          : {
              type: 'twake-scribe:applyAnswer',
              answerAction: 'insert',
              text: makeTableMarkdown(table),
              format: 'markdown'
            }
      }
      return null
    }

    const callCapability = result => {
      const message = makeCapabilityMessage(result)
      if (message === null) {
        // Both the capability identifier and parameters may be controlled by
        // an assistant and can contain document content or credentials.
        logger.warn('Scribe: unsupported or invalid capability ignored')
        return
      }
      plugin.postMessage(message, serverOrigin)
    }

    return {
      isAvailable: plugin !== null,
      isOpen: text !== null,
      content: text?.content,
      target: text?.target,
      canReplace: text?.canReplace,
      documentType,
      // The panel opens once the plugin answers with twake-scribe:content
      open: () => {
        const requestId = ++requestSequence.current
        pendingContentRequest.current = requestId
        plugin.postMessage(
          { type: 'twake-scribe:getContent', requestId },
          serverOrigin
        )
      },
      // The plugin reads every selection while the panel is open, which
      // empties the redo of the editor: it stops once the panel is closed
      close: () => {
        if (sessionId === null) {
          if (
            activePanelRequest.current !== null ||
            pendingContentRequest.current === null
          )
            return
        } else if (!isCurrentPanel()) return
        pendingContentRequest.current = null
        activePanelRequest.current = null
        plugin.postMessage({ type: 'twake-scribe:close' }, serverOrigin)
        setText(null)
      },
      applyResult: result => {
        if (!isCurrentPanel()) return
        if (result?.capability !== undefined) {
          callCapability(result)
          return
        }
        plugin.postMessage(
          { ...result, type: 'twake-scribe:applyAnswer' },
          serverOrigin
        )
      }
    }
  }, [plugin, text, serverOrigin, documentType])

  return (
    <ScribeContext.Provider value={value}>{children}</ScribeContext.Provider>
  )
}
