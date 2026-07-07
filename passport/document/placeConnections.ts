import type { DocConnection, RelationKind } from './types'
import { ARTIFACT_SIZES, PLACEMENT_NUDGES, ROTATION_RANGE } from './figmaGeometry'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Placement {
  id: string
  kind: RelationKind
  x: number
  y: number
  width: number
  height: number
  rotation: number
  order: number
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

/**
 * Deterministic scatter: each connection id hashes to a position inside its
 * grid cell of the safe zone and a rotation within the token range, so the
 * same data always lays out the same way.
 */
export function placeConnections(
  connections: DocConnection[],
  bounds: Bounds,
  rotationRange: { min: number; max: number } = ROTATION_RANGE,
): Placement[] {
  const cols = 2
  const rows = Math.max(1, Math.ceil(connections.length / cols))
  const cellW = bounds.width / cols
  const cellH = bounds.height / rows

  return connections.map((connection, i) => {
    const size = ARTIFACT_SIZES[connection.kind]
    const hash = fnv1a(connection.id)
    const fx = (hash % 997) / 997
    const fy = ((hash >>> 10) % 997) / 997
    const fr = ((hash >>> 20) % 997) / 997

    const col = i % cols
    const row = Math.floor(i / cols) % rows
    const cellX = bounds.x + col * cellW
    const cellY = bounds.y + row * cellH
    const nudge = PLACEMENT_NUDGES[connection.kind] ?? { dx: 0, dy: 0 }

    const x = clamp(cellX + fx * (cellW - size.width) + nudge.dx, bounds.x, bounds.x + bounds.width - size.width)
    const y = clamp(cellY + fy * (cellH - size.height) + nudge.dy, bounds.y, bounds.y + bounds.height - size.height)
    const rotation = rotationRange.min + fr * (rotationRange.max - rotationRange.min)

    return {
      id: connection.id,
      kind: connection.kind,
      x,
      y,
      width: size.width,
      height: size.height,
      rotation,
      order: i,
    }
  })
}
