import type { AssetKey } from '../document/assets'

/** Recognizable passport content for the deck's decorative artifacts. */
export const GALLERY_SAMPLE_VALUES: Record<AssetKey, Record<string, string>> = {
  nametag: { headerLabel: 'SAME TYPE OF WORK', org: 'Netflix', name: 'SARAH MFING FAN' },
  roundStamp: {
    relation: 'same major type',
    ringText: 'IS. 202607. IS. 202607. IS. 202607. IS. 202607. IS. 202607. ',
    name: 'teri taehee shim',
  },
  beliefStamp: { belief: 'creatives can change the wrold', name: 'johnny jonny sheng' },
  photoFrames: {},
  perforation: {},
  sectionBorder: {},
  mrzBand: { mrz: 'P<SOCSHIM<<TERI<TAEHEE<LEMMA<YC<F25<202607<<<' },
  bgText: {},
}
