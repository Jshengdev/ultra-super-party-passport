// passport/document/exportPng.ts — serialize the document SVG, inline the
// fonts, rasterize at 2x, composite the foil surfaces. Fonts are discovered
// at runtime from the page's @font-face rules (next/font self-hosts them),
// so this needs no bundler-specific font imports.

import { PAGE } from './figmaGeometry'
import { generateRose, HOLO_SEAL, ROSE_DEFAULTS } from './holoSeal'

const FAMILY_MATCH = /plex sans|plex mono|garamond/i

const RESOLVED_PROPS = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'opacity',
  'mix-blend-mode',
  'stop-color',
  'stop-opacity',
]

async function toDataUrl(url: string): Promise<string> {
  const buf = await (await fetch(url)).arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:font/woff2;base64,${btoa(binary)}`
}

/** Collect the page's @font-face rules for the document faces, srcs inlined. */
async function fontFaceCss(): Promise<string> {
  const faces: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // cross-origin sheet
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue
      const family = rule.style.getPropertyValue('font-family').replace(/['"_]/g, ' ')
      if (!FAMILY_MATCH.test(family)) continue
      let css = rule.cssText
      const urls = [...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((m) => m[2])
      for (const url of urls) {
        try {
          css = css.replace(url, await toDataUrl(url))
        } catch {
          // font fetch failed; leave the original url
        }
      }
      faces.push(css)
    }
  }
  return faces.join('\n')
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

function holoStops(): string[] {
  const style = getComputedStyle(document.documentElement)
  return ['--holo-1', '--holo-2', '--holo-3', '--holo-4', '--holo-5'].map((n) => style.getPropertyValue(n).trim())
}

/** Foil surfaces redrawn at the frozen pointer position. */
function drawFoil(ctx: CanvasRenderingContext2D, scale: number, texts: { mrz: string; title: string }) {
  const stops = holoStops()
  const cx = PAGE.width * 0.5 * scale
  const cy = PAGE.height * 0.35 * scale

  const conic = ctx.createConicGradient((210 * Math.PI) / 180, cx, cy)
  stops.forEach((color, i) => conic.addColorStop(i / stops.length, color))
  conic.addColorStop(1, stops[0])

  ctx.save()
  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = 0.55
  ctx.strokeStyle = conic
  ctx.translate((HOLO_SEAL.cx - HOLO_SEAL.r) * scale, (HOLO_SEAL.cy - HOLO_SEAL.r) * scale)
  for (const d of generateRose(ROSE_DEFAULTS)) {
    const p = new Path2D(d)
    ctx.save()
    ctx.scale(scale, scale)
    ctx.lineWidth = 0.9
    ctx.stroke(p)
    ctx.restore()
  }
  ctx.restore()

  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  const sheen = ctx.createLinearGradient(0, 0, PAGE.width * scale, PAGE.height * scale)
  sheen.addColorStop(0.3, 'rgba(255,255,255,0)')
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.09)')
  sheen.addColorStop(0.7, 'rgba(255,255,255,0)')
  ctx.fillStyle = sheen
  ctx.fillRect(0, 0, PAGE.width * scale, PAGE.height * scale)
  ctx.restore()

  const textGradient = ctx.createLinearGradient(263 * scale, 0, 608 * scale, 0)
  stops.forEach((color, i) => textGradient.addColorStop(i / (stops.length - 1), color))
  ctx.save()
  ctx.globalAlpha = 0.9
  ctx.fillStyle = textGradient
  ctx.textBaseline = 'top'
  ctx.font = `500 ${14 * scale}px 'IBM Plex Sans'`
  ctx.fillText(texts.mrz, 263 * scale, 723 * scale, 345 * scale)
  ctx.textAlign = 'right'
  ctx.font = `500 ${12 * scale}px 'IBM Plex Sans'`
  ctx.fillText(texts.title, 603 * scale, 399 * scale)
  ctx.restore()
}

export async function exportPassportPng(root: HTMLElement, scale = 2): Promise<Blob> {
  const svg = root.querySelector<SVGSVGElement>('svg.passport-doc')
  if (!svg) throw new Error('exportPassportPng: no passport document found')

  const clone = svg.cloneNode(true) as SVGSVGElement
  const sourceEls = [svg, ...Array.from(svg.querySelectorAll('*'))]
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll('*'))]
  for (let i = 0; i < sourceEls.length; i++) {
    const el = cloneEls[i]
    if (!(el instanceof Element)) continue
    const computed = getComputedStyle(sourceEls[i])
    let style = ''
    for (const prop of RESOLVED_PROPS) {
      const value = computed.getPropertyValue(prop)
      if (value) style += `${prop}:${value};`
    }
    el.setAttribute('style', style)
    el.removeAttribute('class')
  }

  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style')
  styleEl.textContent = await fontFaceCss()
  clone.insertBefore(styleEl, clone.firstChild)
  clone.setAttribute('width', String(PAGE.width * scale))
  clone.setAttribute('height', String(PAGE.height * scale))

  const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = PAGE.width * scale
    canvas.height = PAGE.height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('exportPassportPng: no 2d context')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    drawFoil(ctx, scale, {
      mrz: root.querySelector('.foil-mrz')?.textContent ?? '',
      title: root.querySelector('.foil-title')?.textContent ?? '',
    })
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}
