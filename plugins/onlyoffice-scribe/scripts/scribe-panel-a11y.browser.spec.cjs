const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join, resolve: resolvePath } = require('node:path')

const { test, expect } = require('@playwright/test')
const { rspack } = require('@rspack/core')
const stylus = require('stylus')

let server
let origin
let temporaryOutput

test.beforeAll(async () => {
  const sourceDir = __dirname
  temporaryOutput = mkdtempSync(join(tmpdir(), 'twake-scribe-a11y-'))
  const mocks = resolvePath(sourceDir, 'scribe-panel-a11y.mocks.jsx')
  const aliases = {
    'cozy-ui-plus/dist/Intent/IntentIframe$': mocks,
    'cozy-ui-plus/dist/providers/CozyTheme$': mocks,
    'twake-i18n$': mocks,
    '@/modules/views/OnlyOffice/Scribe/ScribeProvider$': mocks,
    '@/modules/views/OnlyOffice/Scribe/capabilities$': mocks,
    './styles.styl$': resolvePath(sourceDir, 'scribe-panel-a11y.styles.js')
  }
  await new Promise((resolve, reject) => {
    rspack(
      {
        mode: 'development',
        entry: resolvePath(sourceDir, 'scribe-panel-a11y.harness.jsx'),
        output: { path: temporaryOutput, filename: 'bundle.js' },
        target: 'web',
        devtool: false,
        resolve: { alias: aliases, extensions: ['.js', '.jsx'] },
        module: {
          rules: [
            {
              test: /\.jsx$/,
              use: [
                {
                  loader: 'builtin:swc-loader',
                  options: {
                    jsc: {
                      parser: { syntax: 'ecmascript', jsx: true },
                      transform: { react: { runtime: 'automatic' } }
                    }
                  }
                }
              ]
            }
          ]
        }
      },
      (error, stats) => {
        if (error || stats?.hasErrors())
          return reject(error ?? new Error(stats.toString('errors-only')))
        resolve()
      }
    )
  })
  const stylePath = resolvePath(
    sourceDir,
    '../../../src/modules/views/OnlyOffice/Scribe/styles.styl'
  )
  const productionCss = stylus.render(readFileSync(stylePath, 'utf8'))
  const bundle = readFileSync(join(temporaryOutput, 'bundle.js'))
  server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' })
      response.end(bundle)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{margin:0}.editor-layout{display:flex;width:100%}.editor{flex:1;min-width:0}
        ${productionCss}</style>
      <div id="root"></div><script src="/bundle.js"></script>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

test.afterAll(async () => {
  if (server)
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  if (temporaryOutput) rmSync(temporaryOutput, { recursive: true, force: true })
})

test('Scribe keyboard focus follows the assistant and returns to launcher at 320px', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(origin)
  const launch = page.getByRole('button', { name: 'Toggle assistant' })
  await expect(launch).toBeVisible()
  await launch.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('complementary', {
    name: 'OnlyOffice.scribe.open'
  })
  await expect(panel).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('scribe-open-320.png'),
    fullPage: true
  })
  await expect(panel).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(
    page.frameLocator('iframe[title="Scribe assistant"]').getByRole('textbox')
  ).toBeFocused()
  // The assistant closes itself; ensure keyboard users land back on launcher.
  await page.evaluate(() => document.querySelector('#launcher').click())
  await expect(panel).toHaveCount(0)
  await expect(launch).toBeFocused()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(320)
})

test('Scribe cancel from its iframe restores focus across tablet and mobile sizes', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto(origin)
  const launch = page.getByRole('button', { name: 'Toggle assistant' })
  await launch.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('complementary', {
    name: 'OnlyOffice.scribe.open'
  })
  await expect(panel).toBeFocused()
  await page.screenshot({
    path: testInfo.outputPath('scribe-open-tablet-768.png'),
    fullPage: true
  })

  const assistant = page.frameLocator('iframe[title="Scribe assistant"]')
  await page.keyboard.press('Tab')
  await expect(assistant.getByRole('textbox')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(assistant.getByRole('button', { name: 'Close assistant' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(panel).toHaveCount(0)
  await expect(launch).toBeFocused()

  await page.setViewportSize({ width: 320, height: 640 })
  await page.keyboard.press('Enter')
  await expect(panel).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  await page.keyboard.press('Tab')
  await expect(assistant.getByRole('textbox')).toBeFocused()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(panel).toHaveCount(0)
  await expect(launch).toBeFocused()
})
