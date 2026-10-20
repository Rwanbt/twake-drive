import { render, screen } from '@testing-library/react'
import localforage from 'localforage'
import React from 'react'

import { ButtonClient } from './Button'

jest.mock('cozy-client', () => ({ withClient: Component => Component }))
jest.mock('cozy-device-helper', () => ({ isFlagshipApp: () => false }))
jest.mock('twake-i18n', () => ({ translate: () => Component => Component }))
jest.mock('@/config/config.json', () => ({ promoteApp: { isActivated: true } }))
jest.mock('@/components/pushClient', () => ({
  DESKTOP_BANNER: 'desktop_banner',
  DESKTOP_SMALL_BANNER: 'desktop_small_banner',
  isClientAlreadyInstalled: jest.fn().mockResolvedValue(false),
  getDesktopAppDownloadLink: () => 'https://downloads.example.org/drive'
}))
jest.mock('localforage', () => ({ getItem: jest.fn() }))

it('exposes the desktop download as a keyboard-accessible isolated link', async () => {
  localforage.getItem.mockImplementation(key =>
    Promise.resolve(key === 'desktop_banner')
  )
  render(<ButtonClient client={{}} t={key => key} />)

  const link = await screen.findByRole('link', { name: /Twake Drive App/i })
  expect(link).toHaveAttribute('href', 'https://downloads.example.org/drive')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  expect(screen.getByRole('button')).not.toBe(link)
})
