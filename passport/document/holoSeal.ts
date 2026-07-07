/**
 * Pure generator for the circular holo seal (decision fork 3: generated
 * rather than drawn in Figma). The seal sits where the Figma frame had its
 * second photo square, overlapping the photo window.
 */

export interface RoseParams {
  cx: number
  cy: number
  radius: number
  petals: number
  turns: number
}

/** Rose-curve rings for the circular holo seal. */
export function generateRose(params: RoseParams): string[] {
  const { cx, cy, radius, petals, turns } = params
  const paths: string[] = []
  for (let ring = 0; ring < turns; ring++) {
    const r0 = radius * (0.35 + (0.65 * (ring + 1)) / turns)
    let d = ''
    const steps = 240
    for (let s = 0; s <= steps; s++) {
      const theta = (s / steps) * Math.PI * 2
      const r = r0 * (0.72 + 0.28 * Math.cos(petals * theta + ring))
      const x = cx + r * Math.cos(theta)
      const y = cy + r * Math.sin(theta)
      d += (s === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2)
    }
    d += 'Z'
    paths.push(d)
  }
  return paths
}

/** Seal placement in page coordinates: centered on the removed Figma square. */
export const HOLO_SEAL = { cx: 166, cy: 654, r: 70 } as const

export const ROSE_DEFAULTS: RoseParams = {
  cx: HOLO_SEAL.r,
  cy: HOLO_SEAL.r,
  radius: HOLO_SEAL.r,
  petals: 12,
  turns: 5,
}

/** data-uri svg used to mask the foil gradient layers */
export function pathsToMaskUri(paths: string[], width: number, height: number, strokeWidth: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
    paths.map((d) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="${strokeWidth}"/>`).join('') +
    `</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
