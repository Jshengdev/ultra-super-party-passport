/**
 * Geometry lifted verbatim from the Figma frame (file PtbSlTGnuZHrZAYg0GywuE,
 * node 32:3). All values are in the passport page's own coordinate space.
 * These are design data, not styling; color and type come from tokens.css.
 */
import type { RelationKind } from './types'

export const PAGE = { width: 617, height: 774, radius: 20 } as const

export const PERFORATION_Y = 387

export const CONTEXT_LABEL = { x: 25, y: 27, size: 12 } as const
export const TITLE = { xRight: 603, y: 399, size: 12 } as const

export const SECTION_BORDER = { x: 0, y: 426 } as const
export const PHOTO_FRAMES = { x: 25, y: 487 } as const
export const PHOTO_WINDOW = { x: 26, y: 488, width: 153, height: 192 } as const

export const IDENTITY_GRID = {
  col1x: 249,
  col2x: 429,
  rowsY: [461, 503, 545],
  labelSize: 8,
  valueSize: 14,
  valueOffsetY: 12,
} as const

export const PROMPT_QA = {
  x: 249,
  y: 607,
  width: 316,
  labelSize: 8,
  answerSize: 16,
  answerOffsetY: 12,
  answerLineHeight: 21,
} as const

export const MRZ_BAND = { x: 0, y: 712 } as const

export const SAFE_ZONE = { x: 8, y: 46, width: 601, height: 337 } as const

export const ARTIFACT_SIZES = {
  nametag: { width: 274, height: 147 },
  beliefStamp: { width: 266, height: 164 },
  roundStamp: { width: 250, height: 151 },
} as const

export const ROTATION_RANGE = { min: -6, max: 6 } as const

/**
 * Teri's layout adjustments to the deterministic scatter, in page px
 * (one "notch" = 12px). Kind-keyed so the tuning applies to every passport.
 */
export const PLACEMENT_NUDGES: Partial<Record<RelationKind, { dx: number; dy: number }>> = {
  roundStamp: { dx: 36, dy: -24 },
  beliefStamp: { dx: 12, dy: 12 },
}
