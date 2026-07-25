// passport/document/adapter.ts — map the receipted USP passport JSON
// (passport/schema.ts, produced by the graph traversal) onto the document
// renderer's shape. This is the single integration seam: the renderer never
// reads the USP schema directly, and nothing here invents a claim — every
// string comes from the passport JSON or its receipts.

import type { Find, Passport, ReceiptEdge } from '@/passport/schema'
import { sentenceCase } from '@/passport/textCase'
import type { DocConnection, DocGradientStop, DocPassportData } from './types'

const PARTY_CONTEXT = 'People to meet at the LA intern party'
const DOC_TITLE = 'The Ultra Super Social Passport'
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
  // Preferred: the matched person's own belief line, surfaced by the traversal (schema v2).
  if (find.match_belief) {
    const budget = 52
    if (find.match_belief.length <= budget) return find.match_belief
    const words = find.match_belief.split(/\s+/)
    let out = ''
    for (const word of words) {
      if (out && (out + ' ' + word).length > budget) break
      out = out ? `${out} ${word}` : word
    }
    return out
  }
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

/** Long catalog names overflow the data page; the mock's own form is the target ("ARTS, TECH, BIZ"). */
function shortMajor(m: string): string {
  if (m.length <= 24) return m
  if (/arts.*tech.*business/i.test(m)) return 'Arts, Tech & Biz'
  const words = m.split(/\s+/).filter((w) => !/^(&|and|the|of)$/i.test(w))
  return words.slice(0, 3).join(' ').slice(0, 24)
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
      person: { name: sameWork.name, org: orgFromReceipt(sameWork) },
      relation: 'same type of work',
      headerLabel: 'Same type of work',
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
      // Identity fields keep their source casing. sentenceCase only settles the
      // values that ship SHOUTING in data/passports/*.json (position is the big
      // one, 186 distinct), and leaves acronyms like USC / IDBT untouched. The
      // MRZ is unaffected — generateMrz uppercases internally via encode().
      holder: {
        fullName: passport.name,
        company: sentenceCase(
          passport.profile?.company ||
            (passport.profile?.grad_year ? `USC · Class of ${passport.profile.grad_year}` : passport.line2),
        ),
        position: sentenceCase(passport.profile?.position ?? ''),
        gradYear: passport.profile?.grad_year ?? '',
        school: sentenceCase(passport.profile?.school ?? ''),
        major: shortMajor(passport.profile?.major ?? ''),
        note: passport.profile?.working_on
          ? `currently — ${(() => {
              const w = passport.profile.working_on
              if (w.length <= 58) return w
              const cut = w.slice(0, 58)
              return cut.slice(0, cut.lastIndexOf(' ')) + '…'
            })()}`
          : undefined,
        prompt: passport.profile?.belief
          ? { question: 'What is a creative?', answer: passport.profile.belief }
          : { question: 'Your hidden mission', answer: passport.hidden_prompt },
      },
      connections,
    },
    gradientStops: passport.gradient.stops,
  }
}
