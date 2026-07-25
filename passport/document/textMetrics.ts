/**
 * Pure text width estimation for the injection layer. There is no layout
 * engine at injection time, so widths are estimated from per-face average
 * glyph factors (em fraction per character), calibrated against the Figma
 * text boxes for these exact faces.
 */
export type FaceKey = 'document' | 'typewriter' | 'official'

/**
 * Em fraction per character, per face.
 *
 * Recalibrated when `document` and `official` moved from IBM Plex Sans /
 * EB Garamond to Plus Jakarta Sans. Both are deliberately rounded UP: the only
 * consumer is greedy word wrap, so over-estimating makes a line break one word
 * early (safe) while under-estimating overflows the Figma text box (not safe).
 *
 * `typewriter` is untouched — the MRZ and belief stamp still render in IBM Plex
 * Mono, where 0.6em is exact rather than an estimate.
 */
const FACE_FACTOR: Record<FaceKey, number> = {
  document: 0.56, // Plus Jakarta Sans 500, now sentence-cased (was 0.6, Plex Sans caps-heavy)
  typewriter: 0.6, // IBM Plex Mono is exactly 0.6em monospaced
  official: 0.56, // Plus Jakarta Sans (was 0.5 — EB Garamond ran much narrower)
}

export function estimateWidth(value: string, fontSize: number, face: FaceKey): number {
  return value.length * fontSize * FACE_FACTOR[face]
}

/** Greedy word wrap by estimated width; single overlong words stay unbroken. */
export function wrapLines(value: string, maxWidth: number, fontSize: number, face: FaceKey): string[] {
  const words = value.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (current && estimateWidth(candidate, fontSize, face) > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}
