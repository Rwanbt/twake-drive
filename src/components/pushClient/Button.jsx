import { Icon, CrossSmall, Drive } from '@linagora/twake-icons'
import localforage from 'localforage'
import React, { useState, useEffect } from 'react'

import { withClient } from 'cozy-client'
import { isFlagshipApp } from 'cozy-device-helper'
import IconButton from 'cozy-ui/transpiled/react/IconButton'
import ListItem from 'cozy-ui/transpiled/react/ListItem'
import ListItemIcon from 'cozy-ui/transpiled/react/ListItemIcon'
import ListItemText from 'cozy-ui/transpiled/react/ListItemText'
import Paper from 'cozy-ui/transpiled/react/Paper'
import { translate } from 'twake-i18n'

import {
  getDesktopAppDownloadLink,
  isClientAlreadyInstalled,
  DESKTOP_SMALL_BANNER,
  DESKTOP_BANNER
} from '@/components/pushClient'
import Config from '@/config/config.json'

export const ButtonClient = ({ client, t }) => {
  const [mustShow, setMustShow] = useState(false)

  useEffect(() => {
    const checkShouldShowButton = async () => {
      if (Config.promoteApp.isActivated !== true || isFlagshipApp()) return

      const hasBannerBeenClosed =
        (await localforage.getItem(DESKTOP_BANNER)) || false

      // we want to show the button if the banner has been marked as seen *and*
      // the client hasn't been already installed
      if (hasBannerBeenClosed) {
        const hasClientBeenInstalled = await isClientAlreadyInstalled(client)

        const hasSmallBannerBeenClosed =
          (await localforage.getItem(DESKTOP_SMALL_BANNER)) || false

        if (!hasClientBeenInstalled && !hasSmallBannerBeenClosed) {
          setMustShow(true)
        }
      }
    }

    checkShouldShowButton()
  }, [client])

  const handleClick = ev => {
    ev.stopPropagation()
    setMustShow(false)
    localforage.setItem(DESKTOP_SMALL_BANNER, true)
  }

  if (Config.promoteApp.isActivated !== true || !mustShow || isFlagshipApp())
    return null

  const link = getDesktopAppDownloadLink({ t })

  return (
    <Paper
      elevation={10}
      className="u-pos-relative u-mh-1-half u-mb-1-half"
      style={{ backgroundColor: 'var(--defaultBackgroundColor)' }}
    >
      <IconButton
        className="u-top-0 u-right-0"
        style={{ position: 'absolute', zIndex: 1 }}
        size="small"
        aria-label={t('Nav.close')}
        onClick={handleClick}
      >
        <Icon icon={CrossSmall} size={8} />
      </IconButton>
      <ListItem
        component="a"
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="u-c-pointer"
      >
        <ListItemIcon>
          <Icon icon={Drive} size={32} />
        </ListItemIcon>
        <ListItemText
          primaryTypographyProps={{
            variant: 'overline',
            color: 'textPrimary'
          }}
          primary="Twake Drive App"
          secondaryTypographyProps={{
            variant: 'overline',
            color: 'primary'
          }}
          secondary={t('Nav.banner-btn-client')}
        />
      </ListItem>
    </Paper>
  )
}

export default translate()(withClient(ButtonClient))
