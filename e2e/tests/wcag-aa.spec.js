import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { USERS } from '../helpers/config'
import { test, expect } from '../helpers/fixtures'
import { collectWcagFindings } from '../helpers/wcag'

// The audit asks for the accessibility of the web application to be proved on
// the real rendered application, not asserted. This spec measures the WCAG 2.2
// AA checks the audit lists (contrast, labels, accessible names, image
// alternatives, landmarks) on the file list, at every width of the viewport
// matrix, and publishes the complete inventory so the result is reviewable.
//
// The inventory is written to wcag-inventory/ and published as an artifact by
// the E2E workflow.

const VIEWPORTS = [320, 375, 768, 1024, 1440]
const INVENTORY_DIRECTORY = join(__dirname, '..', '..', 'wcag-inventory')

const BASELINE = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'baselines', 'wcag-baseline.json'),
    'utf8'
  ).replace(/^\uFEFF/, '')
)

const writeInventory = (name, inventory) => {
  mkdirSync(INVENTORY_DIRECTORY, { recursive: true })
  writeFileSync(
    join(INVENTORY_DIRECTORY, `${name}.json`),
    JSON.stringify(inventory, null, 2),
    'utf8'
  )
}

test.describe('WCAG 2.2 AA of the file list', () => {
  for (const width of VIEWPORTS) {
    test(
      `the file list is measured at ${width}px`,
      { tag: '@a11y' },
      async ({ alicePage }) => {
        await alicePage.setViewportSize({ width, height: 800 })
        await alicePage.goto(`${USERS.alice.appUrl}/#/folder`)
        await expect(alicePage.getByTestId('fil-content-body')).toBeVisible({
          timeout: 30_000
        })

        const inventory = await collectWcagFindings(
          alicePage,
          `folder-${width}`
        )
        writeInventory(`folder-${width}`, inventory)

        // The measurement must have really visited the rendered page: an empty
        // inventory produced by a scan that saw nothing would prove nothing.
        expect(
          inventory.scanned.textElements,
          'no text element was measured on the file list'
        ).toBeGreaterThan(0)
        expect(
          inventory.scanned.interactiveElements,
          'no interactive element was measured on the file list'
        ).toBeGreaterThan(0)

        // Gate: the findings may not exceed the accepted baseline. A new rule
        // or an increased count is a regression that must be fixed (or the
        // baseline must be re-accepted explicitly with justification).
        const baseline = BASELINE[`folder-${width}`] || {}
        expect(
          inventory.counts['missing-accessible-name'] ?? 0,
          `interactive elements have accessible names at ${width}px`
        ).toBe(0)
        for (const rule of ['color-contrast', 'image-alt', 'form-label']) {
          expect(
            inventory.counts[rule] ?? 0,
            `${rule} findings at ${width}px: ${JSON.stringify(inventory.findings)}`
          ).toBe(0)
        }
        for (const [rule, count] of Object.entries(inventory.counts)) {
          const allowed = baseline[rule] || 0
          expect(
            count,
            `WCAG regression: ${rule} has ${count} findings, baseline allows ${allowed}`
          ).toBeLessThanOrEqual(allowed)
        }
        for (const rule of Object.keys(inventory.counts)) {
          expect(
            Object.prototype.hasOwnProperty.call(baseline, rule),
            `WCAG regression: new rule '${rule}' not present in the accepted baseline`
          ).toBe(true)
        }
      }
    )
  }

  test(
    'the file list has AA text contrast in the dark theme at 1440px',
    { tag: '@a11y' },
    async ({ alicePage }) => {
      await alicePage.addInitScript(() => {
        window.localStorage.setItem('ui-theme', 'dark')
      })
      await alicePage.setViewportSize({ width: 1440, height: 800 })
      await alicePage.goto(`${USERS.alice.appUrl}/#/folder`)
      await expect(alicePage.getByTestId('fil-content-body')).toBeVisible({
        timeout: 30_000
      })
      await expect(alicePage.locator('.TwakeTheme--dark').first()).toHaveClass(
        /TwakeTheme--dark/
      )

      const inventory = await collectWcagFindings(alicePage, 'folder-dark-1440')
      writeInventory('folder-dark-1440', inventory)

      expect(
        inventory.counts['color-contrast'] ?? 0,
        JSON.stringify(inventory.findings)
      ).toBe(0)
    }
  )

  test(
    'the file list stays usable at 200% text scaling',
    { tag: '@a11y' },
    async ({ alicePage }) => {
      await alicePage.setViewportSize({ width: 375, height: 800 })
      await alicePage.goto(`${USERS.alice.appUrl}/#/folder`)
      await expect(alicePage.getByTestId('fil-content-body')).toBeVisible({
        timeout: 30_000
      })

      // Text scaling is applied on the root font size: the layout is built with
      // rem units, so this is the layout consequence of a larger text.
      await alicePage.addStyleTag({
        content: 'html { font-size: 200% !important; }'
      })
      const widths = await alicePage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }))
      writeInventory('folder-200-percent-text', widths)

      expect(
        widths.scrollWidth,
        'the page scrolls sideways at 200% text scaling'
      ).toBeLessThanOrEqual(widths.clientWidth + 1)
    }
  )
})
