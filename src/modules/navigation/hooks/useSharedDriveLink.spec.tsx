import { renderHook } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

import { useSharedDriveLink } from './useSharedDriveLink'
import { ROUTER_FUTURE_FLAGS } from '@/constants/config'

jest.mock('cozy-client', () => ({
  ...jest.requireActual('cozy-client'),
  useClient: jest.fn(() => ({
    getStackClient: () => ({ uri: 'https://cozy.localhost' }),
    getInstanceOptions: () => ({ subdomain: 'nested' })
  }))
}))

jest.mock('@/modules/shareddrives/helpers', () => ({
  getFolderIdFromSharing: () => 'folder-123'
}))

it('opens a modifier-click shared-drive link without granting window.opener', () => {
  const open = jest.spyOn(window, 'open').mockImplementation(() => null)
  const { result } = renderHook(
    () => useSharedDriveLink({ _id: 'share-1', owner: true } as never),
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>{children}</MemoryRouter>
      )
    }
  )
  result.current.openLink({ ctrlKey: true } as React.MouseEvent<HTMLElement>)
  expect(open).toHaveBeenCalledWith(
    expect.stringContaining('cozy.localhost'),
    '_blank',
    'noopener,noreferrer'
  )
  open.mockRestore()
})
