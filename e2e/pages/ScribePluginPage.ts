import type { Frame, Page } from '@playwright/test'

import { getOfficeUrl } from '../helpers/config'
import { expect } from '../helpers/fixtures'
import { normalizeModel, type ScribeModel } from '../helpers/scribeModel'

const PLUGIN_URL = /\/sdkjs-plugins\/twake-scribe\//

/** Name of the frame a hostile page adds to impersonate the plugin. */
const HOSTILE_FRAME_NAME = 'twake-hostile-frame'

export interface ScribeContent {
  content: string
  target: string
  canReplace?: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Runs in the frame of the editor: selects what a spec of the harness names.
 *
 * A spec is one end, or two ends joined by `..`:
 * - `P<n>@<at>`: the n-th paragraph of the body, tables left out (1-based)
 * - `T<n>.C(<r>,<c>)@<at>`: the first paragraph of a cell of the n-th table
 * - `T<n>.C(<r>,<c>).P<m>@<at>`: the m-th paragraph of that cell
 * - `T<n>.full`: the whole table
 *
 * `<at>` is `start`, `end`, `mid`, `space` (after the first space) or an
 * offset in the text of the paragraph. From `start` to `end` of a paragraph,
 * the paragraph is taken whole, with a note or an image after its text; an
 * offset ends the selection at a character. One end alone is the cursor.
 */
function selectInEditor(spec: string): { ok: boolean; error?: string } {
  const Api = (window as any).g_asc_plugins.api.getJsApi()
  const doc = Api.GetDocument()

  const parseEnd = (text: string): any => {
    let match = /^P(\d+)@(\w+)$/.exec(text)
    if (match) return { n: Number(match[1]), at: match[2] }
    match = /^T(\d+)\.C\((\d+),(\d+)\)(?:\.P(\d+))?@(\w+)$/.exec(text)
    if (match) {
      return {
        n: Number(match[1]),
        cell: { r: Number(match[2]), c: Number(match[3]) },
        paragraph: match[4] ? Number(match[4]) : null,
        at: match[5]
      }
    }
    match = /^T(\d+)\.full$/.exec(text)
    if (match) return { n: Number(match[1]), isFull: true }
    return null
  }
  const findNth = (type: string, n: number): any => {
    let seen = 0
    for (let i = 0; i < doc.GetElementsCount(); i += 1) {
      const element = doc.GetElement(i)
      if (element.GetClassType() === type) {
        seen += 1
        if (seen === n) return element
      }
    }
    return null
  }
  const getText = (paragraph: any): string =>
    paragraph.GetText({ Numbering: false }).replace(/[\r\n\t]+$/, '')
  const getOffset = (paragraph: any, at: string): number => {
    const text = getText(paragraph)
    if (/^\d+$/.test(at)) return Math.min(Number(at), text.length)
    if (at === 'end') return text.length
    if (at === 'mid') return Math.floor(text.length / 2)
    if (at === 'space') return text.indexOf(' ') + 1
    return 0
  }
  // A collapsed range at an offset of the text: each run gives the ranges of
  // its own characters, the positions of the document count the runs
  const makeCursor = (paragraph: any, offset: number): any => {
    let passed = 0
    for (let i = 0; i < paragraph.GetElementsCount(); i += 1) {
      const element = paragraph.GetElement(i)
      if (!['run', 'hyperlink'].includes(element.GetClassType())) continue
      const length = element.GetText().replace(/[\r\n]+$/, '').length
      if (offset <= passed + length) {
        return element.GetRange(offset - passed, offset - passed)
      }
      passed += length
    }
    return paragraph.GetRange(0, 0)
  }
  // The cursor at an offset of the text: the editor does not move it to a
  // collapsed range it selects
  const placeCursor = (paragraph: any, offset: number): void => {
    let passed = 0
    for (let i = 0; i < paragraph.GetElementsCount(); i += 1) {
      const element = paragraph.GetElement(i)
      if (element.GetClassType() !== 'run') continue
      const length = element.GetText().replace(/[\r\n]+$/, '').length
      if (offset <= passed + length) {
        element.MoveCursorToPos(offset - passed)
        return
      }
      passed += length
    }
    makeCursor(paragraph, offset).Select()
  }
  const findCellContent = (end: any): any =>
    findNth('table', end.n)?.GetCell(end.cell.r, end.cell.c)?.GetContent() ??
    null

  const [startText, endText = startText] = spec.split('..')
  const start = parseEnd(startText)
  const end = parseEnd(endText)
  if (!start || !end) return { ok: false, error: `bad spec ${spec}` }

  if (start.isFull) {
    const table = findNth('table', start.n)
    if (!table) return { ok: false, error: `no table ${start.n}` }
    table.Select()
    return { ok: true }
  }

  const isSameCell =
    start.cell &&
    end.cell &&
    start.n === end.n &&
    start.cell.r === end.cell.r &&
    start.cell.c === end.cell.c
  // From a cell to another place, the cells are taken whole: the editor
  // stretches such a selection to whole cells anyway
  if (start.cell && !isSameCell) {
    const content = findCellContent(start)
    const startRange = content?.GetElement(0).GetRange()
    const endRange = end.cell
      ? findCellContent(end)
          ?.GetElement(findCellContent(end).GetElementsCount() - 1)
          .GetRange()
      : makeCursor(
          findNth('paragraph', end.n),
          getOffset(findNth('paragraph', end.n), end.at)
        )
    if (!startRange || !endRange)
      return { ok: false, error: `no cell for ${spec}` }
    startRange.ExpandTo(endRange).Select()
    return { ok: true }
  }
  if (!start.cell && end.cell) {
    const paragraph = findNth('paragraph', start.n)
    const content = findCellContent(end)
    if (!paragraph || !content)
      return { ok: false, error: `no end for ${spec}` }
    makeCursor(paragraph, getOffset(paragraph, start.at))
      .ExpandTo(content.GetElement(content.GetElementsCount() - 1).GetRange())
      .Select()
    return { ok: true }
  }

  // In the body, or in one cell: from a paragraph to another, the first
  // paragraph of the cell when the spec names none
  const findParagraph = (end_: any): any => {
    if (!end_.cell) return findNth('paragraph', end_.n)
    return findCellContent(end_)?.GetElement((end_.paragraph ?? 1) - 1) ?? null
  }
  const startParagraph = findParagraph(start)
  const endParagraph = findParagraph(end)
  if (!startParagraph || !endParagraph) {
    return { ok: false, error: `no paragraph for ${spec}` }
  }
  const startOffset = getOffset(startParagraph, start.at)
  const endOffset = getOffset(endParagraph, end.at)
  const isSameParagraph =
    startParagraph.GetInternalId() === endParagraph.GetInternalId()
  // From its start to its end, a paragraph is taken whole, with what follows
  // its text; an offset ends the selection at a character
  const isWholeParagraph =
    isSameParagraph && start.at === 'start' && end.at === 'end' && endOffset > 0
  if (isWholeParagraph) {
    startParagraph.GetRange().Select()
    return { ok: true }
  }
  if (isSameParagraph && startOffset === endOffset) {
    placeCursor(startParagraph, startOffset)
    return { ok: true }
  }
  makeCursor(startParagraph, startOffset)
    .ExpandTo(makeCursor(endParagraph, endOffset))
    .Select()
  return { ok: true }
}

/**
 * Runs in the frame of the editor: the document and its selection, in the
 * form `normalizeModel` makes stable
 */
function readEditor(): ScribeModel {
  const Api = (window as any).g_asc_plugins.api.getJsApi()
  const doc = Api.GetDocument()

  const readFlags = (textPr: any): any => {
    const flags: any = {}
    if (!textPr) return flags
    if (textPr.GetBold()) flags.b = 1
    if (textPr.GetItalic()) flags.i = 1
    if (textPr.GetStrikeout()) flags.s = 1
    if (textPr.GetUnderline()) flags.u = 1
    if (/courier|consolas|mono/i.test(textPr.GetFontFamily() ?? '')) {
      flags.code = 1
    }
    return flags
  }
  const readHyperlink = (hyperlink: any): any => {
    let text = ''
    let first = null
    for (let j = 0; j < hyperlink.GetElementsCount(); j += 1) {
      const run = hyperlink.GetElement(j)
      if (run.GetText() === '') continue
      text += run.GetText()
      first = first ?? run
    }
    if (text === '') return null
    return {
      ...readFlags(first?.GetTextPr()),
      t: text,
      link: hyperlink.GetLinkedText()
    }
  }
  const readRun = (element: any): any => {
    const type = element.GetClassType()
    if (type === 'hyperlink') return readHyperlink(element)
    if (type !== 'run' || element.GetText() === '') return null
    return { ...readFlags(element.GetTextPr()), t: element.GetText() }
  }
  const readList = (paragraph: any): any => {
    const numbering = paragraph.GetNumbering()
    if (!numbering) return null
    const label = paragraph.GetText({ Numbering: true }).split('\t')[0]
    return [numbering.GetLevelIndex(), label]
  }
  const readRuns = (paragraph: any): any[] => {
    const runs = []
    for (let i = 0; i < paragraph.GetElementsCount(); i += 1) {
      const run = readRun(paragraph.GetElement(i))
      if (run) runs.push(run)
    }
    return runs
  }
  const count = (json: string, pattern: RegExp): number =>
    json.match(pattern)?.length ?? 0
  // `normalizeModel` leaves out what is missing or counts 0
  const readParagraph = (paragraph: any): any => {
    const style = paragraph.GetStyle()?.GetName()
    const level = paragraph.GetOutlineLvl()
    const json = paragraph.ToJSON(false, false)
    return {
      type: 'p',
      runs: readRuns(paragraph),
      style: style === 'Normal' ? null : style,
      lvl: typeof level === 'number' && level >= 0 ? level : null,
      list: readList(paragraph),
      images: paragraph.GetAllDrawingObjects().length,
      notes: count(json, /"type":"footnoteRef"/g),
      pageBreaks: count(json, /"breakType":"page"/g),
      // The section properties of a note are in its own JSON: only the ones
      // of the paragraph tell that it ends a section
      section: JSON.parse(json).pPr?.sectPr ? 1 : null
    }
  }
  const readTable = (table: any): any => {
    const layout = JSON.parse(table.ToJSON()).content
    return {
      type: 'table',
      grid: layout.map((row: any, r: number) =>
        row.content.map((laid: any, c: number) => {
          const content = table.GetCell(r, c).GetContent()
          const blocks = []
          for (let i = 0; i < content.GetElementsCount(); i += 1) {
            const element = content.GetElement(i)
            if (element.GetClassType() === 'paragraph') {
              blocks.push(readParagraph(element))
            }
          }
          const cell: any = { blocks }
          const merge = laid.tcPr?.vMerge
          if (merge) cell.vmerge = merge === 'continue' ? 'cont' : 'master'
          if ((laid.tcPr?.gridSpan ?? 1) > 1) cell.hspan = laid.tcPr.gridSpan
          return cell
        })
      )
    }
  }

  // Each paragraph, with where it is: the selection is told by the text it
  // covers, since the positions of the editor count the empty runs
  const located: { at: any; paragraph: any }[] = []
  const blocks = []
  for (let i = 0; i < doc.GetElementsCount(); i += 1) {
    const element = doc.GetElement(i)
    if (element.GetClassType() === 'paragraph') {
      located.push({ at: { block: blocks.length }, paragraph: element })
      blocks.push(readParagraph(element))
    }
    if (element.GetClassType() === 'table') {
      const block = blocks.length
      blocks.push(readTable(element))
      for (let r = 0; r < element.GetRowsCount(); r += 1) {
        for (let c = 0; c < element.GetRow(r).GetCellsCount(); c += 1) {
          const content = element.GetCell(r, c).GetContent()
          for (let p = 0; p < content.GetElementsCount(); p += 1) {
            const paragraph = content.GetElement(p)
            if (paragraph.GetClassType() !== 'paragraph') continue
            located.push({
              at: { block, cell: { r, c }, cellBlock: p },
              paragraph
            })
          }
        }
      }
    }
  }

  const MARK_CAP = 8
  const selection = doc.GetRangeBySelect()
  const selMarkup: any[] = []
  let selMarkupTruncated = false
  if (selection) {
    const selStart = selection.GetStartPos()
    const selEnd = selection.GetEndPos()
    const mark = (paragraph: any): string => {
      let text = ''
      let isOpen = false
      for (let i = 0; i < paragraph.GetElementsCount(); i += 1) {
        const run = paragraph.GetElement(i)
        if (run.GetClassType() !== 'run') continue
        const runText = run.GetText()
        for (let k = 0; k < runText.length; k += 1) {
          const position = run.GetRange(k, k).GetStartPos()
          const isIn = position >= selStart && position < selEnd
          if (isIn !== isOpen) text += isIn ? '«' : '»'
          isOpen = isIn
          text += runText[k]
        }
      }
      return isOpen ? `${text}»` : text
    }
    located.forEach(({ at, paragraph }) => {
      const range = paragraph.GetRange()
      if (range.GetEndPos() < selStart || range.GetStartPos() > selEnd) return
      if (selMarkup.length >= MARK_CAP) {
        selMarkupTruncated = true
        return
      }
      selMarkup.push({ at, text: mark(paragraph) })
    })
  }
  return {
    blocks,
    selText: selection ? selection.GetText() : null,
    selMarkup,
    ...(selMarkupTruncated && { selMarkupTruncated: true as const })
  }
}

/**
 * Drives the scribe plugin of the Document Server as Drive does, by its
 * messages, and reads the document from the editor
 */
export class ScribePluginPage {
  constructor(private readonly page: Page) {}

  private findPlugin(): Frame | null {
    return (
      this.page.frames().find(frame => PLUGIN_URL.test(frame.url())) ?? null
    )
  }

  private editor(): Frame {
    const editor = this.page.frame({ name: 'frameEditor' })
    if (!editor) throw new Error('No editor frame')
    return editor
  }

  private plugin(): Frame {
    const plugin = this.findPlugin()
    if (!plugin) throw new Error('No frame of the scribe plugin')
    return plugin
  }

  /** Opens a document in OnlyOffice and waits for the plugin */
  async open(appUrl: string, fileId: string): Promise<void> {
    await this.page.goto(`${appUrl}/#/onlyoffice/${fileId}`)
    // What the plugin tells Drive is kept here, and not given to Drive: its
    // panel would open
    await this.page.evaluate(() => {
      const messages: unknown[] = []
      Object.assign(window, { scribeMessages: messages })
      window.addEventListener(
        'message',
        event => {
          const { type } = (event.data ?? {}) as { type?: unknown }
          if (typeof type !== 'string' || !type.startsWith('twake-scribe:')) {
            return
          }
          messages.push(event.data)
          event.stopImmediatePropagation()
        },
        true
      )
    })
    await expect(this.page.locator('iframe[name="frameEditor"]')).toBeVisible({
      timeout: 90_000
    })
    // The editor gives the plugin its API when it starts it, some time after
    // its frame is there: the plugin then tells Drive it is ready
    await expect
      .poll(
        () =>
          this.page.evaluate(() =>
            (
              window as unknown as { scribeMessages: { type: string }[] }
            ).scribeMessages.some(({ type }) => type === 'twake-scribe:ready')
          ),
        { timeout: 90_000 }
      )
      .toBe(true)
    // The document is drawn once the editor has its builder
    await expect
      .poll(
        () =>
          this.editor()
            .evaluate(() => {
              const { api } = (
                window as unknown as {
                  g_asc_plugins: {
                    api: {
                      getJsApi: () => {
                        GetDocument?: () => unknown
                      }
                    }
                  }
                }
              ).g_asc_plugins
              const builder = api.getJsApi()
              return Boolean(builder.GetDocument?.())
            })
            .catch(() => false),
        { timeout: 60_000 }
      )
      .toBe(true)
  }

  /** Undoes every change made since the document was opened */
  async reset(): Promise<void> {
    await this.editor().evaluate(() => {
      ;(
        window as unknown as { editor: { asc_undoAllChanges: () => void } }
      ).editor.asc_undoAllChanges()
    })
    await this.page.waitForTimeout(300)
  }

  async select(spec: string): Promise<void> {
    const result = await this.editor().evaluate(selectInEditor, spec)
    if (!result.ok) throw new Error(result.error)
    // The plugin reads a selection once it has settled, as after a user
    await this.page.waitForTimeout(700)
  }

  /** A message of Drive to the plugin, from the window that shows the editor */
  private async send(data: Record<string, unknown>): Promise<void> {
    const origin = new URL(this.page.url()).origin
    await this.plugin().evaluate(
      ({ data, origin }) => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data,
            origin,
            source: window.parent.parent
          })
        )
      },
      { data, origin }
    )
  }

  private async takeMessages(): Promise<{ type: string }[]> {
    return this.page.evaluate(() => {
      const holder = window as unknown as {
        scribeMessages: { type: string }[]
      }
      return holder.scribeMessages.splice(0)
    })
  }

  /** What the plugin gives Drive to work on, as when its button is clicked */
  async getContent(): Promise<ScribeContent> {
    await this.takeMessages()
    await this.send({ type: 'twake-scribe:getContent' })
    let found: ScribeContent | null = null
    await expect
      .poll(
        async () => {
          const messages = await this.takeMessages()
          const message = messages.find(
            ({ type }) => type === 'twake-scribe:content'
          )
          if (message) {
            const { type: _type, ...content } = message
            found = content as unknown as ScribeContent
          }
          return found !== null
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    return found as unknown as ScribeContent
  }

  /** Writes an answer, and waits for the document to be written */
  async applyAnswer(
    answerAction: string,
    text: string,
    read: () => Promise<unknown> = () => this.read()
  ): Promise<void> {
    const before = JSON.stringify(await read())
    await this.send({
      type: 'twake-scribe:applyAnswer',
      answerAction,
      text,
      format: 'markdown'
    })
    // The plugin gives no answer: the document is read until it changes,
    // then until two reads agree
    let last = before
    let isStable = false
    const deadline = Date.now() + 10_000
    while (!isStable && Date.now() < deadline) {
      await this.page.waitForTimeout(400)
      const current = JSON.stringify(await read())
      isStable = current === last && current !== before
      last = current
    }
  }

  async read(): Promise<ScribeModel> {
    return normalizeModel(await this.editor().evaluate(readEditor))
  }

  /**
   * Opens a document and lets the app talk to the plugin: the messages of the
   * plugin are recorded, not intercepted, so the app really receives them.
   */
  async openLive(appUrl: string, fileId: string): Promise<void> {
    await this.page.addInitScript(() => {
      const holder = window as unknown as { scribeMessages: unknown[] }
      holder.scribeMessages = []
      window.addEventListener('message', event => {
        const { type } = (event.data ?? {}) as { type?: unknown }
        if (typeof type !== 'string' || !type.startsWith('twake-scribe:')) {
          return
        }
        holder.scribeMessages.push(event.data)
      })
    })
    await this.page.goto(`${appUrl}/#/onlyoffice/${fileId}`)
    await expect(this.page.locator('iframe[name="frameEditor"]')).toBeVisible({
      timeout: 90_000
    })
    await expect
      .poll(() => this.findPlugin() !== null, { timeout: 90_000 })
      .toBe(true)
    await expect.poll(() => this.hasDocument(), { timeout: 60_000 }).toBe(true)
  }

  /** Whether the editor has drawn the document. */
  private async hasDocument(): Promise<boolean> {
    return this.editor()
      .evaluate(() => {
        const { api } = (
          window as unknown as {
            g_asc_plugins: {
              api: {
                getJsApi: () => {
                  GetDocument?: () => unknown
                }
              }
            }
          }
        ).g_asc_plugins
        const builder = api.getJsApi()
        return Boolean(builder.GetDocument?.())
      })
      .catch(() => false)
  }

  /** Records the messages the plugin frame receives from the app. */
  async startRecordingPluginMessages(): Promise<void> {
    await this.plugin().evaluate(() => {
      const holder = window as unknown as { received: string[] }
      holder.received = []
      window.addEventListener('message', event => {
        const { type } = (event.data ?? {}) as { type?: unknown }
        if (typeof type === 'string' && type.startsWith('twake-scribe:')) {
          holder.received.push(type)
        }
      })
    })
  }

  /** The messages the plugin frame received from the app. */
  async pluginMessages(): Promise<string[]> {
    return this.plugin().evaluate(() => {
      const holder = window as unknown as { received?: string[] }
      return holder.received ?? []
    })
  }

  /**
   * Adds a frame that tries to be the scribe plugin. It is a child of the
   * window that shows the editor, like the real plugin is a child of the
   * editor frame.
   *
   * - `app`: the frame shares the origin of the app, so only the source of
   *   the messages can tell it from the real plugin.
   * - `office`: the frame has the origin of the Document Server, the origin
   *   the app trusts, so only the parent of the frame can tell it from the
   *   real plugin.
   */
  async addHostileFrame(origin: 'app' | 'office'): Promise<void> {
    await this.page.evaluate(
      ({ name, src }) => {
        const existing = document.querySelector(`iframe[name="${name}"]`)
        if (existing) existing.remove()
        const frame = document.createElement('iframe')
        frame.name = name
        frame.title = name
        frame.width = '1'
        frame.height = '1'
        if (src) frame.src = src
        else frame.srcdoc = '<!doctype html><title>hostile</title>'
        document.body.appendChild(frame)
      },
      {
        name: HOSTILE_FRAME_NAME,
        src: origin === 'office' ? `${getOfficeUrl()}/healthcheck` : null
      }
    )
    await expect
      .poll(() => this.hostileFrame() !== null, { timeout: 30_000 })
      .toBe(true)
    await this.hostileFrame()?.evaluate(() => {
      const holder = window as unknown as { received: string[] }
      holder.received = []
      window.addEventListener('message', event => {
        const { type } = (event.data ?? {}) as { type?: unknown }
        if (typeof type === 'string' && type.startsWith('twake-scribe:')) {
          holder.received.push(type)
        }
      })
    })
  }

  /** The frame that tries to be the scribe plugin. */
  private hostileFrame(): Frame | null {
    return (
      this.page.frames().find(frame => frame.name() === HOSTILE_FRAME_NAME) ??
      null
    )
  }

  /** The messages the hostile frame received. */
  async hostileMessages(): Promise<string[]> {
    const frame = this.hostileFrame()
    if (!frame) return []
    return frame.evaluate(() => {
      const holder = window as unknown as { received?: string[] }
      return holder.received ?? []
    })
  }

  /**
   * Makes the hostile frame send a message to the plugin, as a forged answer
   * would. The frame shares the origin of the app, so the message carries the
   * origin the plugin expects: only the source of the message can refuse it.
   */
  async forgeToPlugin(
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const frame = this.hostileFrame()
    if (!frame) throw new Error('No hostile frame')
    await frame.evaluate(
      ({ type, payload }) => {
        const editor = window.parent.document.getElementsByName(
          'frameEditor'
        )[0] as HTMLIFrameElement | undefined
        if (!editor?.contentWindow) throw new Error('No editor frame')
        for (let index = 0; index < editor.contentWindow.frames.length; index += 1) {
          editor.contentWindow.frames[index].postMessage(
            { type, ...payload },
            '*'
          )
        }
      },
      { type, payload }
    )
  }

  /**
   * Makes the hostile frame send a message to the app, as a forged "the
   * plugin is ready" would. The frame has the origin of the Document Server,
   * the origin the app trusts: only the parent of the frame can refuse it.
   */
  async forgeToApp(
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const frame = this.hostileFrame()
    if (!frame) throw new Error('No hostile frame')
    await frame.evaluate(
      ({ type, payload }) => {
        window.parent.postMessage({ type, ...payload }, '*')
      },
      { type, payload }
    )
  }

  /** Waits for the button that opens the assistant beside the document. */
  async waitForScribeButton(): Promise<void> {
    await expect(
      this.page.getByRole('button', { name: /help me write/i })
    ).toBeVisible({ timeout: 60_000 })
  }

  /** Opens the assistant beside the document. */
  async clickScribeButton(): Promise<void> {
    await this.page.getByRole('button', { name: /help me write/i }).click()
  }
}
