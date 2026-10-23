import { render, screen } from '@testing-library/react'
import React from 'react'

import CozyTheme from 'cozy-ui-plus/dist/providers/CozyTheme'

import FileAction from './FileAction'

jest.mock('twake-i18n', () => ({
  useI18n: () => ({ t: key => key })
}))

describe('virtualized file action accessibility', () => {
  it('exposes the localized accessible name on its menu button', () => {
    render(
      <CozyTheme>
        <FileAction onClick={jest.fn()} />
      </CozyTheme>
    )

    expect(
      screen.getByRole('button', { name: 'Toolbar.more' })
    ).toBeInTheDocument()
  })
})
