// passport/schema.ts — the passport zod schema (shared surface; the app + universe read this).
// SHAPE (from the contract):
//   { personId, name, line2 (company||school),
//     find:[{personId,name,why,path_receipt:[{from,rel,to}...]} x2  // [0]=same-work, [1]=values-aligned
//     ],
//     hidden_prompt, magic_inference,
//     gradient:{ seed, stops:[{color,at}...] } }
//
// pepl grounding-by-construction: an unreceipted value should be UNREPRESENTABLE.
// Every `find.why` must reference only entities present in that find's `path_receipt`,
// and every `path_receipt` edge must EXIST in Neo4j (verified by scripts/audit-receipts.ts).

import { z } from "zod";

/** One directed edge of a real graph path: (from)-[:REL]->(to). Audited to exist in Neo4j. */
export const receiptEdgeSchema = z.object({
  from: z.string().min(1), // node display key (Person.name / entity .name / id)
  rel: z.string().min(1),  // relationship TYPE, e.g. "DOES", "WORKS_AT", "SHARES_VALUE"
  to: z.string().min(1),   // node display key
});
export type ReceiptEdge = z.infer<typeof receiptEdgeSchema>;

/** A person to FIND, with the receipted reason. */
export const findSchema = z.object({
  personId: z.string().min(1),
  name: z.string().min(1),
  why: z.string().min(1),                       // cites ONLY entities in path_receipt (+ the two names)
  path_receipt: z.array(receiptEdgeSchema).min(1),
});
export type Find = z.infer<typeof findSchema>;

export const gradientStopSchema = z.object({
  color: z.string().min(1), // any CSS color (we emit hsl(...))
  at: z.number().min(0).max(1),
});
export type GradientStop = z.infer<typeof gradientStopSchema>;

export const gradientSchema = z.object({
  seed: z.number(),                              // deterministic from personId
  stops: z.array(gradientStopSchema).min(2),
});
export type Gradient = z.infer<typeof gradientSchema>;

export const passportSchema = z.object({
  personId: z.string().min(1),
  name: z.string().min(1),
  line2: z.string(),                             // company || school (may be "" if neither exists)
  find: z.array(findSchema).length(2),           // exactly two: [0] same-work, [1] values-aligned
  hidden_prompt: z.string().min(1),              // about someone ELSE to find, never the holder
  magic_inference: z.string().min(1),            // INTERPRETIVE read of the holder's own text; never a verbatim restatement
  gradient: gradientSchema,
});
export type Passport = z.infer<typeof passportSchema>;
