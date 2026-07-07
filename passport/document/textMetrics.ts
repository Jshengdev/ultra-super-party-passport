/**
 * Pure text width estimation for the injection layer. There is no layout
 * engine at injection time, so widths are estimated from per-face average
 * glyph factors (em fraction per character), calibrated against the Figma
 * text boxes for these exact faces.
 */
export type FaceKey = 'document' | 'typewriter' | 'official'

const FACE_FACTOR: Record<FaceKey, number> = {
  document: 0.6, // IBM Plex Sans Medium, caps-heavy document data
  typewriter: 0.6, // IBM Plex Mono is exactly 0.6em monospaced
  official: 0.5, // EB Garamond
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
