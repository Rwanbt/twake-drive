import { readFileSync } from 'fs'
import path from 'path'

import { USERS } from '../helpers/config'
import { test, expect, stamp } from '../helpers/fixtures'
import { DEFAULT_FLAGS, setFlags } from '../helpers/flags'
import { createFile, trashById } from '../helpers/stack'
import { ScribePluginPage } from '../pages/ScribePluginPage'

// The scribe plugin of the Document Server and Drive only talk to each other
// when the message comes from the window that shows the editor. These tests
// play the hostile case against a real Document Server and a real document:
// a frame that tries to be the plugin must never write in the document, nor
// take the place of the plugin the app talks to.

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures')
const DOCX_FIXTURE = path.join(FIXTURE_DIR, 'office-sample.docx')
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const ATTACKER_TEXT = 'ATTACKER-INJECTED'

/** Create a Word document on the instance and return its id. */
async function createWordDocument(label: string): Promise<string> {
  return createFile({
    instance: USERS.alice.instance,
    name: `${label} ${stamp()}.docx`,
    content: readFileSync(DOCX_FIXTURE),
    contentType: DOCX
  })
}

test.describe('OnlyOffice message boundary', () => {
  test(
    'a forged answer from a hostile frame never reaches the document',
    { tag: '@security-smoke' },
    async ({ alicePage }) => {
      const fileId = await createWordDocument('Forged answer')
      try {
        const scribe = new ScribePluginPage(alicePage)
        await scribe.openLive(USERS.alice.appUrl, fileId)
        // The app asks the plugin for the text it works on: the plugin then
        // accepts the messages of the window that shows the editor.
        const content = await scribe.getContent()
        expect(content.content).not.toBe('')
        const before = await scribe.read()

        // The hostile frame shares the origin of the app: the origin of the
        // message is the one the plugin expects. Only the source of the
        // message can refuse it.
        await scribe.addHostileFrame('app')
        await scribe.forgeToPlugin('twake-scribe:applyAnswer', {
          answerAction: 'insert',
          text: ATTACKER_TEXT,
          format: 'markdown'
        })
        await alicePage.waitForTimeout(5_000)

        const after = await scribe.read()
        expect(JSON.stringify(after)).not.toContain(ATTACKER_TEXT)
        expect(after.blocks.length).toBe(before.blocks.length)
      } finally {
        await trashById(USERS.alice.instance, fileId)
      }
    }
  )

  test(
    'a forged ready message from a hostile frame never replaces the plugin',
    { tag: '@security-smoke' },
    async ({ alicePage }) => {
      // The assistant is what asks the plugin for the text of the document.
      setFlags(USERS.alice.instance, {
        ...DEFAULT_FLAGS,
        'cozy.assistant.enabled': true
      })
      const fileId = await createWordDocument('Forged ready')
      try {
        const scribe = new ScribePluginPage(alicePage)
        await scribe.openLive(USERS.alice.appUrl, fileId)
        // The real plugin of the Document Server tells the app it is ready:
        // the button of the assistant appears.
        await scribe.waitForScribeButton()
        await scribe.startRecordingPluginMessages()

        // The hostile frame has the origin of the Document Server, the origin
        // the app trusts: only the parent of the frame can refuse it.
        await scribe.addHostileFrame('office')
        await scribe.forgeToApp('twake-scribe:ready', {})

        // The app must still ask the real plugin for the text of the document.
        await scribe.clickScribeButton()
        await expect
          .poll(() => scribe.pluginMessages(), { timeout: 30_000 })
          .toContain('twake-scribe:getContent')
        expect(await scribe.hostileMessages()).toEqual([])
      } finally {
        await trashById(USERS.alice.instance, fileId)
        // Leave the instance as the other specs expect it.
        setFlags(USERS.alice.instance, DEFAULT_FLAGS)
      }
    }
  )
})
