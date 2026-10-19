import React, { createContext, useContext } from 'react'

export const ScribeContext = createContext(null)
export const useScribe = () => useContext(ScribeContext)
export const useCozyTheme = () => ({ type: 'light' })
export const useI18n = () => ({ t: key => key })
export const makeCapabilities = () => []
export const makeSuggestions = () => []

// The assistant's own application is independent. Only its iframe is mocked;
// the real Twake ScribePanel and its CSS are used by Chromium.
export default function IntentIframe() {
  return (
    <iframe title="Scribe assistant" srcDoc="<input aria-label='Ask Scribe'>" />
  )
}
