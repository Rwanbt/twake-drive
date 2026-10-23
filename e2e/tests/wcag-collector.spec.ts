import { test, expect } from '../helpers/fixtures'
import { collectWcagFindings } from '../helpers/wcag'

test('disabled text is contrast-exempt without suppressing active or semantic checks', async ({
  publicPage
}) => {
  await publicPage.setContent(`
    <main>
      <button disabled style="color: rgb(150, 150, 150); background: white"><span>Native disabled</span></button>
      <div role="button" aria-disabled="true" style="color: rgb(150, 150, 150); background: white"><span>ARIA disabled</span></div>
      <span class="Mui-disabled" style="color: rgb(150, 150, 150); background: white">MUI disabled</span>
      <button style="color: rgb(150, 150, 150); background: white"><span>Active control</span></button>
      <div role="button" aria-disabled="true" style="display:inline-block;width:24px;height:24px"></div>
    </main>
    `)

  const inventory = await collectWcagFindings(
    publicPage,
    'disabled-exemption-fixture'
  )

  expect(inventory.counts['color-contrast']).toBe(1)
  expect(
    inventory.findings.find(finding => finding.rule === 'color-contrast')
      ?.detail
  ).toContain('Active control')
  expect(inventory.counts['missing-accessible-name']).toBe(1)
})
