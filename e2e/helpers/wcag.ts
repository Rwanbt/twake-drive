import type { Page } from '@playwright/test'

/**
 * A deliberately small, dependency free WCAG 2.2 AA collector.
 *
 * It covers the checks the audit asks for on the web application: colour
 * contrast (1.4.3 and 1.4.11), accessible names, image alternatives,
 * form labels and landmarks. It runs inside the page, on the real rendered
 * application, so it measures what a user actually gets.
 *
 * The collector never hides a finding: it returns every one of them. What the
 * test does with the inventory is decided separately.
 */
export interface WcagFinding {
  rule: string
  detail: string
}

export interface WcagInventory {
  page: string
  width: number
  counts: Record<string, number>
  findings: WcagFinding[]
  scanned: {
    textElements: number
    interactiveElements: number
    images: number
    formControls: number
  }
}

const collect = (): {
  findings: WcagFinding[]
  scanned: WcagInventory['scanned']
} => {
  const findings: WcagFinding[] = []
  const add = (rule: string, detail: string): void => {
    findings.push({ rule, detail })
  }

  const parseColor = (value: string): number[] | null => {
    const match = value.match(/rgba?\(([^)]+)\)/)
    if (!match) return null
    const parts = match[1].split(/[,/]/).map(part => parseFloat(part.trim()))
    if (parts.length < 3 || parts.some(part => Number.isNaN(part))) return null
    return parts
  }

  const relativeLuminance = (rgb: number[]): number => {
    const [r, g, b] = rgb.map(value => {
      const channel = value / 255
      return channel <= 0.03928
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  const contrastRatio = (
    foreground: number[],
    background: number[]
  ): number => {
    const first = relativeLuminance(foreground)
    const second = relativeLuminance(background)
    const ratio =
      (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
    return Math.round(ratio * 100) / 100
  }

  const isVisible = (element: Element): boolean => {
    const style = window.getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (parseFloat(style.opacity) === 0) return false
    const box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }

  const effectiveBackground = (element: Element): number[] => {
    let node: Element | null = element
    while (node) {
      const style = window.getComputedStyle(node)
      const color = parseColor(style.backgroundColor)
      if (color && (color.length < 4 || color[3] > 0.9)) {
        return color.slice(0, 3)
      }
      node = node.parentElement
    }
    return [255, 255, 255]
  }

  const isDisabledForContrast = (element: HTMLElement): boolean =>
    element.closest(':disabled, [aria-disabled="true"]') !== null

  const composite = (foreground: number[], background: number[]): number[] => {
    const alpha = foreground.length > 3 ? foreground[3] : 1
    if (alpha >= 1) return foreground.slice(0, 3)
    return [
      foreground[0] * alpha + background[0] * (1 - alpha),
      foreground[1] * alpha + background[1] * (1 - alpha),
      foreground[2] * alpha + background[2] * (1 - alpha)
    ]
  }

  // 1.4.3 and 1.4.11: colour contrast of the text.
  const textElements = Array.from(
    document.querySelectorAll<HTMLElement>(
      'p, span, div, li, td, th, label, h1, h2, h3, h4, h5, h6, a, button, input, textarea, select'
    )
  ).filter(element => {
    if (element.children.length > 0) return false
    const text = (element.textContent ?? '').trim()
    if (!text) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    return isVisible(element)
  })

  for (const element of textElements) {
    // WCAG 1.4.3 exempts inactive UI components. Descendants inherit this
    // contrast exemption, but remain included in semantic checks below.
    if (isDisabledForContrast(element)) continue
    const style = window.getComputedStyle(element)
    const foreground = parseColor(style.color)
    if (!foreground) continue
    const background = effectiveBackground(element)
    const ratio = contrastRatio(composite(foreground, background), background)
    const size = parseFloat(style.fontSize)
    const weight = parseInt(style.fontWeight, 10) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const required = large ? 3 : 4.5
    if (ratio < required) {
      add(
        'color-contrast',
        `${ratio}:1 (required ${required}:1) ${size}px/${weight} "${(element.textContent ?? '').trim().slice(0, 40)}" <${element.tagName.toLowerCase()} class="${element.className}"> color=${style.color} background=${background.join(',')}`
      )
    }
  }

  // 4.1.2: accessible names of the interactive elements.
  const interactiveElements = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="switch"], [role="option"]'
    )
  ).filter(element => {
    if (element.getAttribute('aria-hidden') === 'true') return false
    return isVisible(element)
  })

  const accessibleName = (element: HTMLElement): string => {
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const referenced = labelledBy
        .split(/\s+/)
        .map(id => document.getElementById(id))
        .filter((node): node is HTMLElement => node !== null)
        .map(node => (node.textContent ?? '').trim())
        .join(' ')
        .trim()
      if (referenced) return referenced
    }
    const label = element.getAttribute('aria-label')
    if (label && label.trim()) return label.trim()
    const title = element.getAttribute('title')
    if (title && title.trim()) return title.trim()
    const alt = element.getAttribute('alt')
    if (alt && alt.trim()) return alt.trim()
    const text = (element.textContent ?? '').trim()
    if (text) return text
    const value = element.getAttribute('value')
    if (value && value.trim()) return value.trim()
    return ''
  }

  const diagnosticAttributes = (element: HTMLElement): string =>
    ['id', 'name', 'role', 'placeholder', 'aria-label', 'aria-labelledby']
      .map(attribute => {
        const value = element.getAttribute(attribute)
        return value ? `${attribute}="${value}"` : null
      })
      .filter((value): value is string => value !== null)
      .join(' ')

  for (const element of interactiveElements) {
    const name = accessibleName(element)
    if (!name) {
      add(
        'missing-accessible-name',
        `<${element.tagName.toLowerCase()}${
          element.getAttribute('class')
            ? ` class="${element.getAttribute('class')}"`
            : ''
        }${diagnosticAttributes(element) ? ` ${diagnosticAttributes(element)}` : ''}>`
      )
    }
  }

  // 1.1.1: image alternatives.
  const images = Array.from(document.querySelectorAll('img')).filter(isVisible)
  for (const image of images) {
    if (image.getAttribute('aria-hidden') === 'true') continue
    const alt = image.getAttribute('alt')
    if (alt === null) {
      add(
        'image-alt',
        `<img src="${(image.getAttribute('src') ?? '').slice(0, 60)}"> without an alt attribute`
      )
    }
  }

  // 3.3.2 and 4.1.2: labels of the form controls.
  const formControls = Array.from(
    document.querySelectorAll<HTMLElement>('input, select, textarea')
  ).filter(element => {
    const type = (element.getAttribute('type') ?? '').toLowerCase()
    if (['hidden', 'button', 'submit', 'reset', 'image'].includes(type))
      return false
    return isVisible(element)
  })

  for (const control of formControls) {
    const id = control.getAttribute('id')
    const hasLabelElement =
      (id !== null &&
        document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null) ||
      control.closest('label') !== null
    const hasAria =
      (control.getAttribute('aria-label') ?? '').trim() !== '' ||
      (control.getAttribute('aria-labelledby') ?? '').trim() !== ''
    const hasTitle = (control.getAttribute('title') ?? '').trim() !== ''
    if (!hasLabelElement && !hasAria && !hasTitle) {
      add(
        'form-label',
        `<${control.tagName.toLowerCase()}${
          control.getAttribute('name')
            ? ` name="${control.getAttribute('name')}"`
            : ''
        }${diagnosticAttributes(control) ? ` ${diagnosticAttributes(control)}` : ''}> without a label`
      )
    }
  }

  // 1.3.1 and 2.4.1: the page exposes its structure.
  const hasMain =
    document.querySelector('main, [role="main"]') !== null &&
    isVisible(document.querySelector('main, [role="main"]') as Element)
  if (!hasMain) {
    add('missing-main-landmark', 'the page exposes no main landmark')
  }

  return {
    findings,
    scanned: {
      textElements: textElements.length,
      interactiveElements: interactiveElements.length,
      images: images.length,
      formControls: formControls.length
    }
  }
}

export const collectWcagFindings = async (
  page: Page,
  label: string
): Promise<WcagInventory> => {
  const { findings, scanned } = await page.evaluate(collect)
  const counts: Record<string, number> = {}
  for (const finding of findings) {
    counts[finding.rule] = (counts[finding.rule] ?? 0) + 1
  }
  return {
    page: label,
    width: page.viewportSize()?.width ?? 0,
    counts,
    findings,
    scanned
  }
}
