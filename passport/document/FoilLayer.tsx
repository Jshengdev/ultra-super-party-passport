import { useMemo } from 'react'
import type { Placement } from './placeConnections'
import { PAGE } from './figmaGeometry'
import { generateRose, HOLO_SEAL, pathsToMaskUri, ROSE_DEFAULTS } from './holoSeal'
import './foil.css'

const pct = (v: number, total: number) => `${((v / total) * 100).toFixed(3)}%`

/**
 * Chromatic foil surfaces, masked so shine lives only where foil would:
 * the holo seal over the photo window, the MRZ text, a faint kiss on stamp
 * edges, and the full-page lamination sheen. All layers are driven by
 * --pointer-x / --pointer-y / --tilt only.
 */
export function FoilLayer({ placements, mrz, title }: { placements: Placement[]; mrz: string; title: string }) {
  const sealMask = useMemo(
    () => pathsToMaskUri(generateRose(ROSE_DEFAULTS), HOLO_SEAL.r * 2, HOLO_SEAL.r * 2, 0.9),
    [],
  )

  return (
    <div className="foil-layer" aria-hidden="true">
      <div
        className="foil-surface foil-seal"
        style={{
          left: pct(HOLO_SEAL.cx - HOLO_SEAL.r, PAGE.width),
          top: pct(HOLO_SEAL.cy - HOLO_SEAL.r, PAGE.height),
          width: pct(HOLO_SEAL.r * 2, PAGE.width),
          maskImage: sealMask,
          WebkitMaskImage: sealMask,
        }}
      />
      {placements.map((p) => (
        <div
          key={p.id}
          className="foil-kiss"
          style={{
            left: pct(p.x, PAGE.width),
            top: pct(p.y, PAGE.height),
            width: pct(p.width, PAGE.width),
            height: pct(p.height, PAGE.height),
          }}
        />
      ))}
      <div className="foil-mrz">{mrz}</div>
      <div className="foil-title">{title}</div>
      <div className="foil-lamination" />
    </div>
  )
}
