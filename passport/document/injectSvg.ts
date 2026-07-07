import { estimateWidth, wrapLines, type FaceKey } from './textMetrics'

const PLACEHOLDER = /^CHANGE_[a-zA-Z]+$/
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Replace every CHANGE_<field> placeholder text node in an SVG string with
 * the matching value. Pure: string in, string out.
 *
 * - A placeholder whose field has no value provided throws, naming the field,
 *   so a schema/asset mismatch surfaces immediately.
 * - If a value overflows the placeholder's original box (data-fit-width),
 *   textLength/lengthAdjust is applied to that node; the artifact itself is
 *   never resized. data-fit-always forces the stretch both ways (band labels).
 * - data-wrap-width wraps the value into tspans at data-line-height.
 */
export function injectSvg(rawSvg: string, values: Record<string, string>): string {
  const doc = new DOMParser().parseFromString(rawSvg, 'image/svg+xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('injectSvg: could not parse SVG source')
  }

  const leaves = Array.from(doc.querySelectorAll('text, tspan, textPath')).filter(
    (node) => node.children.length === 0,
  )

  for (const node of leaves) {
    const content = node.textContent?.trim() ?? ''
    if (!PLACEHOLDER.test(content)) continue

    const field = content.slice('CHANGE_'.length)
    if (!(field in values)) {
      throw new Error(`injectSvg: no value provided for placeholder field "${field}"`)
    }
    const value = values[field]

    const host = node.closest('text') ?? node
    const fontSize = Number(host.getAttribute('data-size') ?? 16)
    const face = (host.getAttribute('data-font') ?? 'document') as FaceKey

    const wrapWidth = host.getAttribute('data-wrap-width')
    if (wrapWidth) {
      const lines = wrapLines(value, Number(wrapWidth), fontSize, face)
      const x = host.getAttribute('x') ?? '0'
      const lineHeight = host.getAttribute('data-line-height') ?? String(fontSize)
      node.textContent = ''
      lines.forEach((line, i) => {
        const tspan = doc.createElementNS(SVG_NS, 'tspan')
        tspan.setAttribute('x', x)
        tspan.setAttribute('dy', i === 0 ? '0' : lineHeight)
        tspan.textContent = line
        node.appendChild(tspan)
      })
      continue
    }

    node.textContent = value

    const fitWidth = host.getAttribute('data-fit-width')
    if (fitWidth && node.tagName !== 'textPath') {
      const overflows = estimateWidth(value, fontSize, face) > Number(fitWidth)
      if (overflows || host.getAttribute('data-fit-always') === 'true') {
        host.setAttribute('textLength', fitWidth)
        host.setAttribute('lengthAdjust', 'spacingAndGlyphs')
      }
    }
  }

  return new XMLSerializer().serializeToString(doc.documentElement)
}

/** Rewrite the root <svg> tag's attributes (nesting, sizing) without touching content. */
export function withRootAttrs(
  svgMarkup: string,
  attrs: Record<string, string | number>,
  drop: string[] = [],
): string {
  const end = svgMarkup.indexOf('>')
  let tag = svgMarkup.slice(0, end)
  const rest = svgMarkup.slice(end)
  for (const name of [...drop, ...Object.keys(attrs)]) {
    tag = tag.replace(new RegExp(`\\s${name}="[^"]*"`), '')
  }
  const added = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')
  return `${tag} ${added}${rest}`
}
