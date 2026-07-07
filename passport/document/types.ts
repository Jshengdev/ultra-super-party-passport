// passport/document/types.ts — the document renderer's own data shape.
// This is the render-side contract of the imported social-passport project;
// the USP passport JSON (passport/schema.ts) is mapped onto it by adapter.ts.

export type RelationKind = 'nametag' | 'roundStamp' | 'beliefStamp'

export interface DocConnection {
  id: string
  kind: RelationKind
  person: { name: string; org?: string }
  relation: string
  headerLabel?: string
  sharedBelief?: string
  ringText?: string
}

export interface DocHolder {
  fullName: string
  company: string
  position: string
  gradYear: string
  school: string
  major: string
  prompt: { question: string; answer: string }
  note?: string // one subtle personal line (small italic, above the MRZ)
  photoUrl?: string
}

export interface DocPassportData {
  meta: { title: string; context: string; issued: string }
  holder: DocHolder
  connections: DocConnection[]
}

export interface DocGradientStop {
  color: string
  at: number
}
