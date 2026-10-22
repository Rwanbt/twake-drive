import { USERS } from '../helpers/config'
import { test, expect, stamp } from '../helpers/fixtures'

// Probes the layout of the file list at the widths the audit asks for, and
// the size of the targets a pointer or a finger has to reach (WCAG 2.2 AA,
// 2.5.8 Target Size (Minimum): 24 by 24 CSS pixels).

const VIEWPORTS = [320, 375, 768, 1024, 1440]
const MINIMUM_TARGET = 24

test.describe('Responsive file list', () => {
  for (const width of VIEWPORTS) {
    test(`the file list fits a ${width}px wide viewport`, { tag: '@a11y' }, async ({
      alicePage
    }) => {
      await alicePage.setViewportSize({ width, height: 800 })
      await alicePage.goto(`${USERS.alice.appUrl}/#/folder`)
      await expect(alicePage.getByTestId('fil-content-body')).toBeVisible({
        timeout: 30_000
      })
      const widths = await alicePage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth
      }))
      expect(
        widths.scrollWidth,
        `the page scrolls sideways at ${width}px`
      ).toBeLessThanOrEqual(widths.clientWidth + 1)
    })
  }

  test('the targets of the file list are large enough', { tag: '@a11y' }, async ({
    alicePage
  }) => {
    await alicePage.setViewportSize({ width: 375, height: 800 })
    await alicePage.goto(`${USERS.alice.appUrl}/#/folder`)
    await expect(alicePage.getByTestId('fil-content-body')).toBeVisible({
      timeout: 30_000
    })
    const tooSmall = await alicePage.evaluate(minimum => {
      const targets = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, a[href], input[type="button"], input[type="checkbox"], [role="button"]'
        )
      )
      return targets
        .filter(target => {
          const box = target.getBoundingClientRect()
          if (box.width === 0 || box.height === 0) return false
          if (target.getAttribute('aria-hidden') === 'true') return false
          return box.width < minimum || box.height < minimum
        })
        .map(target => {
          const box = target.getBoundingClientRect()
          return {
            tag: target.tagName,
            label:
              target.getAttribute('aria-label') ??
              target.textContent?.trim().slice(0, 40) ??
              '',
            width: Math.round(box.width),
            height: Math.round(box.height)
          }
        })
    }, MINIMUM_TARGET)
    expect(
      tooSmall,
      `targets smaller than ${MINIMUM_TARGET}px: ${JSON.stringify(tooSmall)}`
    ).toEqual([])
  })

  test('the file list works when the animations are reduced', { tag: '@a11y' }, async ({
    alicePage
  }) => {
    await alicePage.emulateMedia({ reducedMotion: 'reduce' })
    await alicePage.setViewportSize({ width: 375, height: 800 })
    await alicePage.goto(`${USERS.alice.appUrl}/#/folder`)
    await expect(alicePage.getByTestId('fil-content-body')).toBeVisible({
      timeout: 30_000
    })
  })
})
