// passport/document/adapter.ts — map the receipted USP passport JSON
// (passport/schema.ts, produced by the graph traversal) onto the document
// renderer's shape. This is the single integration seam: the renderer never
// reads the USP schema directly, and nothing here invents a claim — every
// string comes from the passport JSON or its receipts.

import type { Find, Passport, ReceiptEdge } from '@/passport/schema'
import type { DocConnection, DocGradientStop, DocPassportData } from './types'

const PARTY_CONTEXT = 'PEOPLE TO MEET AT THE LA INTERN PARTY'
const DOC_TITLE = 'THE ULTRA SUPER SOCIAL PASSPORT'
const ISSUED = '20260718' // the party date, 7/18

/** company from the find's receipts, when a WORKS_AT edge exists for them. */
function orgFromReceipt(find: Find): string | undefined {
  const edge = find.path_receipt.find(
    (e: ReceiptEdge) => e.rel === 'WORKS_AT' && e.from.toLowerCase() === find.name.toLowerCase(),
  )
  return edge?.to
}

/**
 * The shared belief for the stamp. Prefers a real value node from the
 * receipts; otherwise condenses the (receipted) why into a belief-shaped
 * phrase — strip the "you should meet X because" framing, keep the substance,
 * and cut at a word boundary so it wraps cleanly across the stamp's lines.
 */
function beliefFromReceipt(find: Find, holderName: string): string {
  const names = new Set([find.name.toLowerCase(), holderName.toLowerCase()])
  const valueEdge = find.path_receipt.find(
    (e: ReceiptEdge) => e.rel === 'SHARES_VALUE' && !names.has(e.to.toLowerCase()),
  )
  if (valueEdge) return valueEdge.to

  // Take the first sentence, then keep the substance AFTER the reasoning
  // pivot ("because|since|as|share|:"), which is where the recommendation
  // prose turns into the actual shared-belief content. Robust across the
  // varied why phrasings ("you should meet X because...", "you'll love
  // meeting X, as her...", "both of you share...").
  const sentence = (find.why.split(/[.!?]/)[0] ?? find.why).trim()
  const pivot = sentence.match(/\b(?:because|since|as|share[sd]?|value|believe in)\b[:\s]+/i)
  let clause = (pivot ? sentence.slice(pivot.index! + pivot[0].length) : sentence).trim()
  // drop leading connectives/possessives and any trailing verb tail that
  // turns the phrase back into a recommendation ("... could inspire you")
  clause = clause.replace(/^(?:his|her|their|your|a|an|the|of|that|share[sd]?|both of you)\s+/i, '').trim()
  clause = clause.replace(/\s+\b(?:could|would|might|will|can|may)\s+\w+.*$/i, '').trim()

  const budget = 52 // wraps to ~3 typewriter lines in the stamp
  if (clause.length <= budget) return clause
  const words = clause.split(/\s+/)
  let out = ''
  for (const word of words) {
    if (out && (out + ' ' + word).length > budget) break
    out = out ? `${out} ${word}` : word
  }
  return out
}

export interface AdaptedPassport {
  data: DocPassportData
  gradientStops: DocGradientStop[]
}

export function fromUspPassport(passport: Passport): AdaptedPassport {
  const [sameWork, valuesAligned] = passport.find

  const connections: DocConnection[] = [
    {
      id: `${passport.personId}-same-work`,
      kind: 'nametag',
      person: { name: sameWork.name.toUpperCase(), org: orgFromReceipt(sameWork) },
      relation: 'same type of work',
      headerLabel: 'SAME TYPE OF WORK',
    },
    {
      id: `${passport.personId}-values`,
      kind: 'beliefStamp',
      person: { name: valuesAligned.name.toLowerCase() },
      relation: 'you both believe',
      sharedBelief: beliefFromReceipt(valuesAligned, passport.name),
    },
    {
      id: `${passport.personId}-issued`,
      kind: 'roundStamp',
      person: { name: passport.name.toLowerCase() },
      relation: 'la intern party 7/18',
      ringText: 'IS. 20260718. IS. 20260718. IS. 20260718. IS. 20260718. ',
    },
  ]

  return {
    data: {
      meta: { title: DOC_TITLE, context: PARTY_CONTEXT, issued: ISSUED },
      holder: {
        fullName: passport.name.toUpperCase(),
        company: passport.line2.toUpperCase(),
        position: '',
        gradYear: '',
        school: '',
        major: '',
        prompt: { question: 'Your hidden mission', answer: passport.hidden_prompt },
      },
      connections,
    },
    gradientStops: passport.gradient.stops,
  }
}
