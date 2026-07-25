/**
 * passport/textCase.ts — display-layer sentence casing.
 *
 * The all-caps in this product is not only styling: it is baked into
 * data/passports/*.json. 186 distinct `position` values ship as
 * "ECONOMIC SYSTEMS MAPPER", and path receipts carry raw edge types like
 * SHARES_VALUE. Regenerating those needs Neo4j + gateway creds, so the type
 * pass fixes them where they are rendered instead.
 *
 * These are PURE DISPLAY helpers. They never touch stored data, so the graph,
 * the receipts audit, and the ontology keep seeing the exact strings they wrote
 * — a `path_receipt` still resolves against the real edge type (law c).
 */

/**
 * Sentence-case a SHOUTING string, leaving everything else exactly as written.
 *
 * Only strings that are entirely uppercase are reshaped, so ordinary prose and
 * already-cased names pass through untouched. A standalone short token is read
 * as an acronym or a course code — USC, IDBT, CPNS, ISE all appear in the real
 * data and "Usc" / "Idbt" would be wrong — so it is preserved verbatim.
 */
export function sentenceCase(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  // not shouting → leave alone (this is the common case)
  if (trimmed !== trimmed.toUpperCase()) return trimmed
  // a lone short all-caps token is an acronym / code, not a shout
  if (!/\s/.test(trimmed) && trimmed.length <= 5) return trimmed
  const lower = trimmed.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Turn a graph edge type into readable prose for a receipt chain:
 * SHARES_VALUE -> "shares value", STUDIES_AT -> "studies at".
 * The underlying rel string is unchanged; this is the label only.
 */
export function humanizeRel(rel: string): string {
  return rel.trim().toLowerCase().replace(/_+/g, ' ')
}
