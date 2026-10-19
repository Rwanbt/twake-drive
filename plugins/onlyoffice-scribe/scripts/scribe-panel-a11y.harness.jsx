import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ScribeContext } from './scribe-panel-a11y.mocks'
import { ScribePanel } from '../../../src/modules/views/OnlyOffice/Scribe/ScribePanel'

function Harness() {
  const [isOpen, setIsOpen] = useState(false)
  const close = () => setIsOpen(false)
  return (
    <ScribeContext.Provider
      value={{
        isOpen,
        content: 'Selected document text',
        target: 'document',
        canReplace: true,
        documentType: 'word',
        close,
        applyResult: () => {}
      }}
    >
      <main>
        <button type="button" id="launcher" onClick={() => setIsOpen(!isOpen)}>
          Toggle assistant
        </button>
        <div className="editor-layout">
          <div className="editor" aria-label="Document editor">
            Document editor
          </div>
          <ScribePanel />
        </div>
      </main>
    </ScribeContext.Provider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
