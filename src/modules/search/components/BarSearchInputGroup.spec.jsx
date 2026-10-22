import { render, screen } from '@testing-library/react'
import React from 'react'

import CozyTheme from 'cozy-ui-plus/dist/providers/CozyTheme'

import BarSearchInputGroup from './BarSearchInputGroup'

describe('BarSearchInputGroup accessibility', () => {
  it('names the clear-search icon button', () => {
    render(
      <CozyTheme>
        <BarSearchInputGroup
          clearLabel="Clear search"
          isInputNotEmpty
          onClean={jest.fn()}
        >
          <input aria-label="Search anything" />
        </BarSearchInputGroup>
      </CozyTheme>
    )

    expect(
      screen.getByRole('button', { name: 'Clear search' })
    ).toBeInTheDocument()
  })

  it('does not render the clear button while the search is empty', () => {
    render(
      <CozyTheme>
        <BarSearchInputGroup
          clearLabel="Clear search"
          isInputNotEmpty={false}
          onClean={jest.fn()}
        >
          <input aria-label="Search anything" />
        </BarSearchInputGroup>
      </CozyTheme>
    )

    expect(screen.queryByRole('button', { name: 'Clear search' })).toBe(null)
  })
})
