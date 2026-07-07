// passport/document/assets.ts — artifact manifest: exported viewBoxes and the
// mapping from schema fields onto each asset's CHANGE_ placeholder fields.
import type { DocConnection, RelationKind } from './types'
import {
  BELIEF_STAMP_SVG,
  BG_TEXT_SVG,
  MRZ_BAND_SVG,
  NAMETAG_SVG,
  PERFORATION_SVG,
  PHOTO_FRAMES_SVG,
  ROUND_STAMP_SVG,
  SECTION_BORDER_SVG,
} from './assets.gen'

export type AssetKey =
  | 'nametag'
  | 'roundStamp'
  | 'beliefStamp'
  | 'photoFrames'
  | 'perforation'
  | 'sectionBorder'
  | 'mrzBand'
  | 'bgText'

export interface AssetDef {
  raw: string
  width: number
  height: number
  fields: string[]
}

export const ASSETS: Record<AssetKey, AssetDef> = {
  nametag: { raw: NAMETAG_SVG, width: 274, height: 147, fields: ['headerLabel', 'org', 'name'] },
  roundStamp: { raw: ROUND_STAMP_SVG, width: 250, height: 151, fields: ['relation', 'ringText', 'name'] },
  beliefStamp: { raw: BELIEF_STAMP_SVG, width: 266, height: 164, fields: ['belief', 'name'] },
  photoFrames: { raw: PHOTO_FRAMES_SVG, width: 156, height: 195, fields: [] },
  perforation: { raw: PERFORATION_SVG, width: 617, height: 4, fields: [] },
  sectionBorder: { raw: SECTION_BORDER_SVG, width: 617, height: 34, fields: [] },
  mrzBand: { raw: MRZ_BAND_SVG, width: 617, height: 34.7173, fields: ['mrz'] },
  bgText: { raw: BG_TEXT_SVG, width: 1120, height: 659, fields: [] },
}

export const KIND_TO_ASSET: Record<RelationKind, AssetKey> = {
  nametag: 'nametag',
  roundStamp: 'roundStamp',
  beliefStamp: 'beliefStamp',
}

/** Map a connection onto the placeholder fields of its artifact. */
export function connectionValues(connection: DocConnection): Record<string, string> {
  switch (connection.kind) {
    case 'nametag':
      return {
        headerLabel: connection.headerLabel ?? connection.relation.toUpperCase(),
        org: connection.person.org ?? '',
        name: connection.person.name,
      }
    case 'roundStamp':
      return {
        relation: connection.relation,
        ringText: connection.ringText ?? '',
        name: connection.person.name,
      }
    case 'beliefStamp':
      return {
        belief: connection.sharedBelief ?? '',
        name: connection.person.name,
      }
  }
}
