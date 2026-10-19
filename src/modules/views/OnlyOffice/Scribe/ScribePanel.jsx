import React, { useEffect, useRef } from 'react'

import IntentIframe from 'cozy-ui-plus/dist/Intent/IntentIframe'
import { useCozyTheme } from 'cozy-ui-plus/dist/providers/CozyTheme'
import { useI18n } from 'twake-i18n'

import styles from './styles.styl'

import { useScribe } from '@/modules/views/OnlyOffice/Scribe/ScribeProvider'
import {
  makeCapabilities,
  makeSuggestions
} from '@/modules/views/OnlyOffice/Scribe/capabilities'

export const ScribePanel = () => {
  const { t } = useI18n()
  const { type: themeType } = useCozyTheme()
  const panelRef = useRef(null)
  const {
    isOpen,
    content,
    target,
    canReplace,
    documentType,
    close,
    applyResult
  } = useScribe()

  useEffect(() => {
    if (!isOpen) return
    const panel = panelRef.current
    const previouslyFocused = document.activeElement
    // The intent iframe loads asynchronously. Focus its landmark first so
    // keyboard users can reach the assistant on the next Tab.
    panel?.focus()

    return () => {
      if (
        previouslyFocused?.isConnected &&
        (panel?.contains(document.activeElement) ||
          document.activeElement === document.body)
      ) {
        previouslyFocused.focus()
      }
    }
  }, [isOpen])

  if (!isOpen) return null

  // A selection that holds what an answer cannot give back, as an image or a
  // note, is not offered to be replaced. An older plugin does not tell.
  const answerActions =
    target === 'selection' && canReplace !== false
      ? ['insert', 'replace']
      : ['insert']
  const capabilities = makeCapabilities({ documentType, t })
  const suggestions = makeSuggestions({ documentType, t })
  const data = {
    content,
    answerActions: answerActions.map(name => ({
      name,
      label: t(`OnlyOffice.scribe.${name}`)
    })),
    // Left out when empty: the assistant then shows its own chips
    ...(capabilities.length > 0 && { capabilities }),
    ...(suggestions.length > 0 && { suggestions }),
    theme: { type: themeType }
  }

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className={styles['scribe-panel']}
      aria-label={t('OnlyOffice.scribe.open')}
    >
      <IntentIframe
        action="OPEN"
        type="io.cozy.ai.chat.conversations"
        data={data}
        onResult={applyResult}
        onCancel={close}
        onTerminate={close}
      />
    </aside>
  )
}
