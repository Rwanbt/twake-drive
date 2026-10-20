import React, { createContext, useContext, useEffect, useRef } from 'react'

export const ScribeContext = createContext(null)
export const useScribe = () => useContext(ScribeContext)
export const useCozyTheme = () => ({ type: 'light' })
export const useI18n = () => ({ t: key => key })
export const makeCapabilities = () => []
export const makeSuggestions = () => []

// The assistant's own application is independent. Only its iframe is mocked;
// the real Twake ScribePanel and its CSS are used by Chromium.
export default function IntentIframe({ onCancel }) {
  const iframeRef = useRef(null)
  useEffect(() => {
    const onMessage = event => {
      if (
        event.source === iframeRef.current?.contentWindow &&
        event.data === 'twake-scribe-mock:cancel'
      )
        onCancel()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onCancel])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={`<input aria-label="Ask Scribe"><button onclick="parent.postMessage('twake-scribe-mock:cancel', '*')">Close assistant</button>`}
    />
  )
}
