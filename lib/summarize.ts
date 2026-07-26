/**
 * lib/summarize.ts — the summary pass: one distilled read per guest, plus a LABELLED inference.
 *
 * The conviction pass (`lib/conviction.ts`) is deliberately conservative about `mission` and
 * `impact` — it tags them only when the guest literally names the change they want to make or the
 * effect they want on an audience, so most guests come back null on both, BY DESIGN. This pass is
 * the other half of that decision: it reads the same four answers and writes down (1) OUR distilled
 * read of the person in one short line, and (2) where the evidence is strong enough, OUR labelled
 * guess at their mission/impact from the SAME closed vocabularies.
 *
 * THE THREE-REGISTER LAW (why `summary` and `inferred` are separate keys, forever):
 *   register 1 — what the guest STATED         → `lib/conviction.ts` tags + verbatim quotes
 *   register 2 — what WE READ into it          → `summary` here
 *   register 3 — what WE LABELLED them as      → `inferred` here
 * Register 3 is never allowed to masquerade as register 1. A consumer that wants "what they told
 * us" reads the conviction artifact; a consumer that wants "our read" reads this one and must say
 * so out loud. This file is NOT "fixing" the extraction — null stays the common correct answer.
 *
 * THE LAWS this file obeys:
 *   (b) every LLM call is wrapped by a deterministic guard. FOUR layers here:
 *       1. SHAPE  — `chat(..., BatchSchema)` (zod). `mission`/`impact` are `z.enum`s over the
 *          conviction vocabularies, so an off-vocabulary label is UNREPRESENTABLE.
 *       2. QUOTE  — every evidence quote goes through `verifyQuotes` (imported, never re-written)
 *          and what gets STORED is the SNAPPED span: a byte-literal substring of the guest's own
 *          answer. A receipt the guest never wrote is a fabricated receipt.
 *       3. READ   — {@link checkSummaryText}, the generalized `magicGuard` from lib/passport.ts:
 *          the summary must be an interpretation, not a restatement, and must not carry internal
 *          flag vocabulary or anything PII-shaped (downstream tripwires are byte-blind).
 *       4. FLOOR  — a non-null inference below {@link INFER_MIN_CONFIDENCE} is dropped to null and
 *          COUNTED (the caller prints the count) — a weak label is not a label.
 *       Offenders get ONE targeted retry naming the violations; whatever still fails gets a null
 *       record carrying {@link SUMMARY_GUARD_FAILED_FLAG}, pushed onto `Guest.flags` in place.
 *       Never a silent fallback.
 *   (c) every claim carries a receipt — `summary` needs >=1 verified evidence span, and so does
 *       every non-null `inferred` value. No evidence, no claim.
 *   (d) provenance is written INSIDE the artifact, at extraction time: `{_src, _model, _ts,
 *       _actor}`. `_model` is the model that ACTUALLY produced these records — captured once here
 *       and carried in the file, never re-derived later from an env var that may have changed
 *       since (the emit leg attests the conviction model that way today; do not copy that).
 *
 * DEGRADED: `GatewayNotConfigured` propagates untouched — no creds is not a guard failure.
 *
 * Shared surface: `SUMMARIES_PATH`, `SUMMARY_GUARD_FAILED_FLAG`, `summaryModel`, `summariesPath`,
 * `extractSummaries`, `checkSummaryText`, `summaryCacheKey`, and the `PersonSummary` /
 * `SummariesArtifact` shapes.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { chat, CHAT_MODELS, GatewayNotConfigured, type ChatMessage } from "./gateway";
import {
  IMPACTS, MISSIONS, QUOTE_FIELDS, MAX_QUOTE_WORDS, hasEvidence, verifyQuotes,
  type Impact, type Mission, type QuoteField,
} from "./conviction";
import type { Guest } from "./guests";

// ---------------------------------------------------------------------------
// Constants + knobs.
// ---------------------------------------------------------------------------

/** Where the pass caches itself. Gitignored — guest answer text never enters the repo. */
export const SUMMARIES_PATH = "data/graph-private/summaries.json";

/** Flag stamped on `Guest.flags` AND on the written record when the guards fail twice. */
export const SUMMARY_GUARD_FAILED_FLAG = "summary-guard-failed";

/** `_src` provenance for the whole artifact (law d). Version it if the prompt materially changes. */
export const SUMMARY_SRC = "inference:summary-v1";

/** Batch size — the house pattern (`lib/conviction.ts`, `scripts/extract-interests.ts`). */
export const BATCH = 20;

/** `summary.text` bounds. Under 8 chars is not a read; over 140 is a paragraph, not a line. */
export const SUMMARY_MIN_CHARS = 8;
export const SUMMARY_MAX_CHARS = 140;

/**
 * A verbatim run of more than this many characters shared with a source answer means the "read"
 * swallowed the guest's own words. Pinned to lib/passport.ts's `magicGuard` (20) so the two
 * non-restatement checks in this repo agree on what "restated" means.
 */
export const VERBATIM_RUN_CHARS = 20;

/**
 * Confidence floor for a LABELLED inference. Below this the label is dropped to null rather than
 * written: the whole point of this register is that it is our considered read, and a coin-flip is
 * not a read. Dropped labels are counted and reported — a guard that rejects loudly is not a
 * silent fallback. `summary` has no floor (its confidence is informative, not gating).
 *
 * Pinned to 0.60 because that is where the prompt's OWN confidence bands put the line: 0.60+ means
 * "clearly implied by specific language", below it means "a thin read". The floor and the rubric
 * the model is scoring against must be the same number, or the floor is arbitrary.
 */
export const INFER_MIN_CONFIDENCE = 0.6;

/**
 * The chat model for this pass. Read at CALL time, not import time.
 *
 * NOT `DEFAULT_CHAT_MODEL`: that is gpt-4o-mini, and the conviction pass's live golden showed it
 * cannot hold a verbatim-quote instruction (it lengthens spans on the retry). Haiku 4.5 is the
 * model the v2 pipeline actually runs on (CLAUDE.md, graph v2 runbook). `SUMMARY_MODEL` overrides.
 */
export function summaryModel(): string {
  return process.env.SUMMARY_MODEL?.trim() || CHAT_MODELS.CLAUDE_HAIKU;
}

/**
 * Artifact path, `SUMMARIES_JSON` overridable.
 *
 * WHY THIS EXISTS: `GUESTS_FILTER` is destructive — a 10-person golden run writes a 10-person
 * artifact over the 312-person one, and the cache below would then treat 302 people as misses.
 * Point `SUMMARIES_JSON` at a temp path for every filtered run. Same pattern as `CONVICTIONS_JSON`
 * in `scripts/enrich-matches.ts`.
 */
export function summariesPath(): string {
  return process.env.SUMMARIES_JSON?.trim() || SUMMARIES_PATH;
}

/** Batch override — the only lever if a batch's JSON ever gets truncated by an output cap. */
export function summaryBatch(): number {
  const n = Number(process.env.SUMMARY_BATCH);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : BATCH;
}

// ---------------------------------------------------------------------------
// Shapes.
// ---------------------------------------------------------------------------

/** One receipt: a field the guest was asked, and the SNAPPED byte-literal span from it. */
export interface SummaryEvidence {
  field: QuoteField;
  quote: string;
}

/** Register 2 — our distilled read. `evidence` is non-empty by construction (law c). */
export interface SummaryBody {
  text: string;
  confidence: number;
  evidence: SummaryEvidence[];
}

/** Register 3 — our LABEL, from a closed vocabulary, with its own receipts. */
export interface InferredClaim<T extends string = string> {
  value: T;
  confidence: number;
  evidence: SummaryEvidence[];
}

export interface PersonSummary {
  /** null = no answers to read, or the guards failed twice (then `flags` says which). */
  summary: SummaryBody | null;
  /** Structurally segregated from anything the guest stated. null is the common correct answer. */
  inferred: {
    mission: InferredClaim<Mission> | null;
    impact: InferredClaim<Impact> | null;
  };
  /** Present ONLY on a double guard failure — the failure must survive into the artifact. */
  flags?: string[];
}

/**
 * The file. Provenance sits at the top (law d), records are nested under `records` rather than
 * flat-at-root like the conviction artifact — so that `Object.entries(records)` can never hand a
 * consumer a `_model` string where a record is expected.
 *
 * `_keys[personId]` is the incremental-cache key for that record: present only for records this
 * pass would be willing to reuse. Guard failures deliberately get NO key, so the next run re-asks
 * them instead of freezing a failure into the cache.
 */
export interface SummariesArtifact {
  _src: string;
  _model: string;
  _ts: string;
  _actor: "agent";
  _keys: Record<string, string>;
  records: Record<string, PersonSummary>;
}

// ---- wire shapes (what the model must return) ------------------------------

const EvidenceSchema = z.object({
  field: z.enum(QUOTE_FIELDS),
  quote: z.string(),
});

const BodySchema = z.object({
  text: z.string(),
  // NOT range-constrained at the zod layer on purpose: a single out-of-range number would fail the
  // WHOLE batch's shape guard. Range is a per-person post-guard violation → targeted retry.
  confidence: z.number(),
  evidence: z.array(EvidenceSchema).default([]),
});

const MissionClaimSchema = z.object({
  value: z.enum(MISSIONS), // off-vocabulary is unrepresentable (law b, layer 1)
  confidence: z.number(),
  evidence: z.array(EvidenceSchema).default([]),
});

const ImpactClaimSchema = z.object({
  value: z.enum(IMPACTS),
  confidence: z.number(),
  evidence: z.array(EvidenceSchema).default([]),
});

/**
 * `mission`/`impact` ride at the ITEM top level on the wire and are re-nested under `inferred` by
 * us: one less level of nesting for the model to get wrong, and the artifact shape stays pinned
 * regardless of what the model does.
 */
const ItemSchema = z.object({
  personId: z.string(),
  summary: BodySchema.nullable(),
  mission: MissionClaimSchema.nullable().default(null),
  impact: ImpactClaimSchema.nullable().default(null),
});
type SummaryItem = z.infer<typeof ItemSchema>;

const BatchSchema = z.object({ items: z.array(ItemSchema) });

// ---- artifact shape (what we read back off disk) ---------------------------

const StoredEvidence = z.object({ field: z.enum(QUOTE_FIELDS), quote: z.string() });
const StoredBody = z.object({
  text: z.string(),
  confidence: z.number(),
  evidence: z.array(StoredEvidence),
});
const StoredRecord = z.object({
  summary: StoredBody.nullable(),
  inferred: z.object({
    mission: z.object({ value: z.enum(MISSIONS), confidence: z.number(), evidence: z.array(StoredEvidence) }).nullable(),
    impact: z.object({ value: z.enum(IMPACTS), confidence: z.number(), evidence: z.array(StoredEvidence) }).nullable(),
  }),
  flags: z.array(z.string()).optional(),
});
const ArtifactSchema = z.object({
  _src: z.string(),
  _model: z.string(),
  _ts: z.string(),
  _actor: z.literal("agent"),
  _keys: z.record(z.string()).default({}),
  records: z.record(StoredRecord).default({}),
});

// ---------------------------------------------------------------------------
// Guard 3 — the READ guard (generalized `magicGuard`, lib/passport.ts:167-182).
// ---------------------------------------------------------------------------

/**
 * Vocabulary that must never reach a guest's eyes.
 *
 * MIRRORS `FLAG_PATTERNS` in `scripts/audit-graph.ts` (obligation 3, the dignity floor). That
 * audit is the downstream enforcer over `public/graph`; this is the pre-filter, so text it would
 * reject never gets written in the first place. Keep the two lists in sync — audit-graph is the
 * authority, and it cannot be imported here (it is a script with a `main()` and a driver import).
 */
const FLAG_PATTERNS: Array<[string, RegExp]> = [
  ["flag-token", /\b(missing-school|missing-answers|conviction-guard-failed|summary-guard-failed)\b/i],
  ["flag-shape", /\bmissing-[a-z][a-z-]*\b/i],
  ["flag-shape", /\bguard-failed\b/i],
  ["debug-leak", /\b(undefined|NaN)\b/],
  ["debug-leak", /\[object Object\]/],
];

/**
 * PII shapes. MIRRORS `PII_SOURCES` in `scripts/audit-graph.ts` (obligation 5), plus a bare `@`:
 * the audit exempts `@` inside the guests' OWN answer text, and this text is ours, not theirs, so
 * for us any `@` is a handle leaking through. Matches are named, never echoed.
 */
const PII_PATTERNS: Array<[string, RegExp]> = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["gmail", /gmail/i],
  ["edu-address", /\.edu\b/i],
  ["phone", /(?<!\d)(?:\+?1[ .\-]?)?(?:\(\d{3}\)|\d{3})[ .\-]\d{3}[ .\-]\d{4}(?!\d)/],
  ["luma-url", /luma\.com/i],
  ["url", /\bhttps?:\/\//i],
  ["handle", /@/],
];

/** Normalization for the restatement comparison — same recipe as `magicGuard`. */
function normRead(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The READ guard: `text` must be an INTERPRETATION of `sources`, not a restatement of one, and
 * must carry nothing that downstream byte-blind tripwires would (correctly) call a leak.
 *
 * Generalizes `magicGuard` (lib/passport.ts) — same three restatement rules (exact normalized
 * match; a source swallowed whole; the text being a verbatim slice of a source), with the length
 * bounds retuned for a one-line summary and two extra scans (flag vocabulary, PII shapes).
 *
 * Pure + synchronous: re-runnable by an audit without the extraction that produced the text.
 *
 * @param sources the four answer fields — everything the model was shown.
 * @returns the violation list (empty = clean), phrased for the retry nudge.
 */
export function checkSummaryText(text: string, sources: string[]): string[] {
  const violations: string[] = [];
  const trimmed = text.trim();

  if (trimmed.length < SUMMARY_MIN_CHARS || trimmed.length > SUMMARY_MAX_CHARS) {
    violations.push(
      `summary.text is ${trimmed.length} chars (must be ${SUMMARY_MIN_CHARS}-${SUMMARY_MAX_CHARS})`,
    );
  }

  const t = normRead(trimmed);
  if (!t) {
    violations.push("summary.text is empty after normalization");
    return violations; // nothing left to compare
  }

  for (const src of sources) {
    const s = normRead(src);
    if (!s) continue;
    if (t === s) {
      violations.push("summary.text is a verbatim restatement of an answer — write YOUR read of it");
      break;
    }
    if (s.length > VERBATIM_RUN_CHARS && t.includes(s)) {
      violations.push("summary.text swallowed a whole answer verbatim — interpret, do not copy");
      break;
    }
    if (t.length > VERBATIM_RUN_CHARS && s.includes(t)) {
      violations.push("summary.text is a verbatim slice of an answer — interpret, do not copy");
      break;
    }
  }

  for (const [name, re] of FLAG_PATTERNS) {
    if (re.test(trimmed)) violations.push(`summary.text carries internal ${name} vocabulary`);
  }
  for (const [name, re] of PII_PATTERNS) {
    if (re.test(trimmed)) violations.push(`summary.text is ${name}-shaped — no handles, addresses, numbers or links`);
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The prompt.
// ---------------------------------------------------------------------------

/** Keep the rendered batch bounded; a quote from the visible prefix is still a substring. */
const ANSWER_CAP = 600;

function renderAnswer(v: string): string {
  const one = (v ?? "").replace(/\s+/g, " ").trim();
  return one.length > ANSWER_CAP ? one.slice(0, ANSWER_CAP) : one || "(blank)";
}

/**
 * The exact answer block the model sees for one guest. Also the cache key's payload — key and
 * prompt can never drift, because there is one function.
 *
 * `title`/`school`/`company` are deliberately NOT shown: a mission or an impact inferred from a
 * job title is exactly the failure mode the conviction pass forbids, and a title in view invites
 * the "read" to be a restatement of it. The model sees the four answers and nothing else, which
 * also means the READ guard's `sources` cover 100% of what it was given.
 */
export function renderAnswers(g: Guest): string {
  return [
    `  goal: ${renderAnswer(g.answers.goal)}`,
    `  drew: ${renderAnswer(g.answers.drew)}`,
    `  seeking: ${renderAnswer(g.answers.seeking)}`,
    `  inspiration: ${renderAnswer(g.answers.inspiration)}`,
  ].join("\n");
}

function renderGuest(g: Guest): string {
  return `personId: ${g.personId}\n${renderAnswers(g)}`;
}

const SYSTEM = [
  "You read a party guest's own signup answers and write TWO things: ONE short distilled read of",
  "them, and — where their answers support it — a labelled read of their mission and their impact.",
  "Return one item per listed personId. Use EXACTLY the personId strings given.",
  "",
  "The four fields you are shown, all written by the guest:",
  "  goal        — their ultimate goal in pursuing entertainment",
  "  drew        — what drew them to the industry",
  "  seeking     — the kind of people they want to connect with",
  "  inspiration — their biggest inspiration",
  "",
  "FIELD 1 — summary (required for every guest who wrote anything)",
  `  summary.text: ${SUMMARY_MIN_CHARS}-${SUMMARY_MAX_CHARS} characters. ONE clause naming the THROUGH-LINE across their`,
  "    answers: the thing they keep circling, what they are actually chasing, the shape of the",
  "    person behind the four answers. Write it as a third-person read (\"wants to…\", \"chases…\").",
  "    - INTERPRET, never restate. If your sentence could be found in their answers with a search",
  "      box, it is wrong and the guest is thrown away. Never reuse a run of their wording.",
  "    - Be SPECIFIC to this person. \"Loves film and wants to make things\" fits three hundred",
  "      people and is worthless; name the particular pull, tension, or angle THIS one has.",
  "    - Do NOT state their name. Do NOT name any company, school, film, show, or person.",
  "    - No @ symbol, no handles, no email addresses, no \".edu\", no phone numbers, no links.",
  "    - Plain words. No emoji, no quotation marks, no ellipsis, no internal jargon.",
  "  summary.confidence: 0-1, how well the evidence supports YOUR read.",
  "    0.85-1.0 they say it outright, and across more than one answer",
  "    0.60-0.84 clearly implied by specific language in one answer",
  "    below 0.60 a thin read — allowed here, but see the inference floor",
  "  summary.evidence: 1-3 items proving the read came from THEIR words. Each is",
  "    {\"field\": goal|drew|seeking|inspiration, \"quote\": a SHORT VERBATIM fragment of that field}.",
  "",
  "FIELD 2 — mission and impact: OUR LABEL, and the reason this pass exists",
  "  mission (the change they want their work to make), EXACTLY one of:",
  MISSIONS.join(", "),
  "  impact (the effect they want on an audience), EXACTLY one of:",
  IMPACTS.join(", "),
  "  READING BETWEEN THE LINES IS THE POINT OF THESE TWO FIELDS. A separate pass already records",
  "  only what guests state in so many words; this one is the considered read on top of it. When",
  "  the four answers TAKEN TOGETHER point at one of the listed changes or effects, NAME IT and back",
  "  it with a quote. Do not withhold a label because the guest never used the word mission, never",
  "  said \"my mission is\", or only implied it while talking about something else. A guest saying",
  "  what they want people to walk away with, who they want the industry to make room for, or what",
  "  they refuse to let be forgotten HAS given you a label — take it.",
  "  They are still judgements, not facts, so:",
  "    - never from the kind of work alone. \"wants to be an agent\" is a career, not a mission,",
  "      until something in their answers says what they want that career to CHANGE.",
  "    - a genre or a medium they love is not an impact; what they want an audience to FEEL or DO is.",
  "    - craft-excellence is NOT the fallback for anyone who cares about their work. Use it only when",
  "      the QUALITY of the craft itself is plainly the thing they are chasing. Caring is not a mission.",
  "    - an inspiration's achievements belong to that person, not to the guest. Never label a guest",
  "      from what they admire in someone else unless they say they want the same thing.",
  "    - they are different questions. mission = the change in the world or the industry.",
  "      impact = the effect on the person watching. A guest can clearly have one and not the other.",
  "  CALIBRATION: across a batch this size expect a good number of clear missions and clear impacts —",
  "  not all of them, and DEFINITELY not none of them. Returning null for every guest in the batch is",
  "  the single most common way to get this task wrong; labelling every guest is the other. Before",
  "  you finish, re-read the goal and drew answers of anyone you left all-null and check you did not",
  "  skip a label that is sitting there in their own words.",
  `  A non-null label needs its own confidence >= ${INFER_MIN_CONFIDENCE} and its own evidence (1-2 quotes, same rules).`,
  "  If you cannot copy an exact fragment that backs the label, the label is null.",
  "  Use ONLY the exact strings from the two lists above. NEVER invent a label, never reword one.",
  "",
  "  WORKED EXAMPLES (invented guests):",
  '    "I want the kids in my town to see a version of themselves that is not a punchline"',
  "      -> mission representation-feel-seen · impact make-people-feel-seen",
  '    "if someone forgets their week for two hours in my theater then I did my job"',
  "      -> mission null (no change named) · impact create-escape-wonder",
  '    "the crew credits scroll past and nobody knows who any of them are, I want that to change"',
  "      -> mission elevate-underdogs · impact null (nothing about an audience)",
  '    "I love being on set and I want to work with fun people" -> mission null · impact null',
  "",
  "QUOTE RULES — these decide whether the guest is kept at all",
  "  - 12 WORDS MAX, one contiguous fragment. Never a whole sentence, never the whole answer.",
  "  - Copy it CHARACTER-FOR-CHARACTER. NEVER add, remove, or change punctuation or capitalization —",
  "    not even a trailing period. Do not wrap it in quotation marks. Begin and end mid-sentence if",
  "    that is where the evidence is.",
  "  - Never paraphrase, never merge two fields, never quote a field shown as (blank).",
  "  - An edited or invented quote is rejected by a verbatim substring check and the guest is",
  "    thrown away. If you cannot copy exactly, pick a different fragment you CAN copy.",
  "",
  "  WORKED EXAMPLE — given this field text:",
  "    drew: I grew up on my mom's set watching her cut trailers, and by the time I was twelve I",
  "    knew I wanted to be the one deciding what an audience feels.",
  '  GOOD quote (8 words): "grew up on my mom\'s set watching her"',
  '  GOOD summary: "Raised beside the edit bay, and now after the seat that decides what an audience feels"',
  '  BAD summary: "I grew up on my mom\'s set watching her cut trailers." (restatement, not a read)',
  '  BAD summary: "Passionate about storytelling and eager to learn." (fits anyone — says nothing)',
  '  BAD quote: "I grew up on my mom\'s set watching her cut trailers." (whole sentence + added period)',
  "",
  "Respond with ONLY a JSON object of this exact shape — BOTH item shapes below are normal:",
  '{"items":[',
  '  {"personId":"...","summary":{"text":"...","confidence":0.86,"evidence":[{"field":"drew","quote":"..."}]},',
  '   "mission":{"value":"elevate-underdogs","confidence":0.72,"evidence":[{"field":"goal","quote":"..."}]},',
  '   "impact":null},',
  '  {"personId":"...","summary":{"text":"...","confidence":0.64,"evidence":[{"field":"goal","quote":"..."}]},',
  '   "mission":null,"impact":null}',
  "]}",
].join("\n");

async function askBatch(guests: Guest[], model: string, nudge: string | null): Promise<SummaryItem[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        (nudge ? `${nudge}\n\n` : "") +
        `Guests (${guests.length}):\n\n${guests.map(renderGuest).join("\n\n")}`,
    },
  ];
  const out = await chat(model, messages, BatchSchema);
  // `.default([])`/`.default(null)` fill these at parse time; the `??`s are their type-level twins
  // (zod's inferred INPUT type still marks a defaulted field optional).
  return out.items.map((it) => ({
    personId: it.personId,
    summary: it.summary ? { ...it.summary, evidence: it.summary.evidence ?? [] } : null,
    mission: it.mission ? { ...it.mission, evidence: it.mission.evidence ?? [] } : null,
    impact: it.impact ? { ...it.impact, evidence: it.impact.evidence ?? [] } : null,
  }));
}

const RETRY_NUDGE =
  "Your previous answer was REJECTED for these guests. Redo ONLY them, fixing exactly what is " +
  "named below. For a rejected quote: SHORTEN it to a contiguous fragment of 12 words or fewer " +
  "copied character-for-character out of the named field — do not lengthen it, do not add a " +
  "trailing period, do not re-capitalize, do not paraphrase, never stitch two parts of the answer " +
  "together; if you cannot copy one exactly, pick a different fragment you CAN copy, and if a " +
  "mission or impact label has no copyable evidence, return null for that label. For a rejected " +
  "summary: write a genuinely different sentence — your own read of the person, reusing none of " +
  "their wording, naming no company, school or person, with no @ symbol, address, number or link " +
  "in it. mission and impact must be null or an EXACT string from the two lists you were given — " +
  "an invented or reworded label fails the whole batch, so when unsure use null.";

// ---------------------------------------------------------------------------
// The incremental cache.
// ---------------------------------------------------------------------------

/**
 * The cache key: sha256(personId + model + the exact rendered answer text).
 *
 * Answers change → key changes → re-asked. Model changes → the WHOLE file is discarded (below),
 * because mixing two models' reads in one artifact would make `_model` a lie (law d).
 */
export function summaryCacheKey(personId: string, model: string, rendered: string): string {
  return createHash("sha256").update(`${personId} ${model} ${rendered}`).digest("hex");
}

/** Read the artifact, or null when absent/unreadable/malformed (a bad cache is simply no cache). */
export function loadSummaries(path: string = summariesPath()): SummariesArtifact | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = ArtifactSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return null;
    return parsed.data as SummariesArtifact;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The post-guard (quote + read + floor), per person.
// ---------------------------------------------------------------------------

/** Verify one evidence list, returning the SNAPPED spans. Any bad quote is a violation. */
function verifyEvidence(
  guest: Guest,
  where: string,
  evidence: SummaryEvidence[],
  violations: string[],
): SummaryEvidence[] {
  const out: SummaryEvidence[] = [];
  const seen = new Set<string>();
  for (const ev of evidence) {
    // ONE call per item, not one call for the list: `verifyQuotes` takes a Record keyed by field,
    // which would silently collapse two quotes from the same field into one.
    const check = verifyQuotes(guest, { quotes: { [ev.field]: ev.quote } });
    if (!check.ok) {
      violations.push(`${where}: ${check.violations.join("; ")}`);
      continue;
    }
    const snapped = check.snapped[ev.field];
    if (snapped === undefined) continue; // unreachable when ok, but never store an undefined span
    const dedupeKey = `${ev.field} ${snapped}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ field: ev.field, quote: snapped });
  }
  return out;
}

/** Artifact-stable numbers: two decimals, clamped into [0,1] after the range check passed. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function checkConfidence(where: string, c: number, violations: string[]): boolean {
  if (!Number.isFinite(c) || c < 0 || c > 1) {
    violations.push(`${where}.confidence ${c} is out of range (0-1)`);
    return false;
  }
  return true;
}

export interface GuardOutcome {
  /** Everything wrong with the item, phrased for the retry nudge. Empty = a perfect item. */
  violations: string[];
  /**
   * The LAW-CLEAN record, or null when the summary itself cannot stand.
   *
   * "Law-clean" is a lower bar than "perfect" on purpose, and the two are separated so the caller
   * can hold the model to `violations.length === 0` on the first ask and to the LAW on the last.
   * A law-clean record contains only spans that verified against the guest's own bytes and only
   * labels that kept at least one such span (law c). It may be non-null while `violations` is not:
   * that is a record worth re-asking for, not a record worth throwing a person away over.
   */
  record: PersonSummary | null;
  /** Labels dropped by the confidence floor — counted, reported, never silent. */
  dropped: number;
  /** Labels dropped because not one of their quotes survived verification. */
  droppedNoEvidence: number;
}

/**
 * The whole per-person post-guard: the READ guard on the text, `verifyQuotes` on every span, the
 * confidence floor on every label. Nothing unverified is ever placed in the returned record.
 */
export function guardItem(guest: Guest, item: SummaryItem): GuardOutcome {
  const violations: string[] = [];
  let dropped = 0;
  let droppedNoEvidence = 0;

  if (!item.summary) {
    return {
      violations: ["no summary returned for a guest who wrote answers"],
      record: null, dropped, droppedNoEvidence,
    };
  }

  // ---- the summary. Any problem with the TEXT itself is fatal: it is the deliverable.
  const sources = QUOTE_FIELDS.map((f) => guest.answers[f] ?? "");
  const textViolations = checkSummaryText(item.summary.text, sources);
  violations.push(...textViolations);
  const confOk = checkConfidence("summary", item.summary.confidence, violations);

  const summaryEvidence = verifyEvidence(guest, "summary.evidence", item.summary.evidence, violations);
  if (summaryEvidence.length === 0) {
    violations.push("summary has no verifiable evidence — every read needs at least one real quote");
  }
  const summaryStands = textViolations.length === 0 && confOk && summaryEvidence.length > 0;

  // ---- the labelled register. A label that cannot carry a receipt is dropped, not fabricated,
  // and dropping it never costs the guest their summary.
  let mission: InferredClaim<Mission> | null = null;
  if (item.mission) {
    if (!checkConfidence("mission", item.mission.confidence, violations)) {
      droppedNoEvidence++; // range already reported; the label cannot be stored either way
    } else if (item.mission.confidence < INFER_MIN_CONFIDENCE) {
      dropped++; // policy, not an error — no violation, so no retry is spent on it
    } else {
      const ev = verifyEvidence(guest, "mission.evidence", item.mission.evidence, violations);
      if (ev.length === 0) {
        violations.push(`mission "${item.mission.value}" has no verifiable evidence — dropped`);
        droppedNoEvidence++;
      } else {
        mission = { value: item.mission.value, confidence: round2(item.mission.confidence), evidence: ev };
      }
    }
  }

  let impact: InferredClaim<Impact> | null = null;
  if (item.impact) {
    if (!checkConfidence("impact", item.impact.confidence, violations)) {
      droppedNoEvidence++;
    } else if (item.impact.confidence < INFER_MIN_CONFIDENCE) {
      dropped++;
    } else {
      const ev = verifyEvidence(guest, "impact.evidence", item.impact.evidence, violations);
      if (ev.length === 0) {
        violations.push(`impact "${item.impact.value}" has no verifiable evidence — dropped`);
        droppedNoEvidence++;
      } else {
        impact = { value: item.impact.value, confidence: round2(item.impact.confidence), evidence: ev };
      }
    }
  }

  return {
    violations,
    dropped,
    droppedNoEvidence,
    record: summaryStands
      ? {
          summary: {
            text: item.summary.text.trim(),
            confidence: round2(item.summary.confidence),
            evidence: summaryEvidence,
          },
          inferred: { mission, impact },
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// extractSummaries — cached, batched, guarded, fail-loud.
// ---------------------------------------------------------------------------

/** No answers to read, or the guards failed twice. `flags` distinguishes the two. */
function emptySummary(flags?: string[]): PersonSummary {
  return {
    summary: null,
    inferred: { mission: null, impact: null },
    ...(flags?.length ? { flags } : {}),
  };
}

function markGuest(guest: Guest, flag: string): void {
  if (!guest.flags.includes(flag)) guest.flags.push(flag);
}

export interface ExtractSummariesResult {
  artifact: SummariesArtifact;
  /** Guests with answers, i.e. eligible to be asked (cache hits included). */
  askable: number;
  /** Served from the cache without a gateway call. */
  hits: number;
  /** Freshly extracted this run. */
  extracted: number;
  /** Guests whose guards failed twice this run. */
  failed: number;
  /** Guests with all four answers blank — never asked, never a failure. */
  skipped: number;
  /** Labels dropped by the confidence floor. */
  droppedInferences: number;
  /** Labels dropped on the final attempt because no quote of theirs verified. */
  droppedNoEvidence: number;
  /** Records accepted on the final attempt while still carrying named violations. */
  tolerated: number;
}

/**
 * A summary for every guest, keyed by personId, with provenance stamped at extraction time.
 *
 * Per guest: no answers → empty record, never asked. Cache hit (same personId + model + answers)
 * → reused, no gateway call. Otherwise batched by {@link summaryBatch}: ask → shape guard (zod,
 * inside `chat`) → post guard ({@link guardItem}) → re-ask ONLY the offenders, once → whatever
 * still fails gets `emptySummary([SUMMARY_GUARD_FAILED_FLAG])` and the same flag pushed onto
 * `guest.flags` (mutated in place, so the failure reaches every surface that reads `Guest.flags`).
 *
 * THE TWO BARS. The first ask is held to `violations.length === 0` — anything less and we spend
 * the retry, because a better answer is still available. The retry is held to the LAW only
 * ({@link GuardOutcome}.record): after it there IS no better answer, so a record whose stored
 * spans all verify is kept and the residual violations are logged as TOLERATED rather than costing
 * the guest their summary. The alternative — conviction's throw-the-guest-away — costs a good
 * one-line read because the model fumbled one of three optional quotes. Nothing unverified is ever
 * stored either way; the difference is only whether an imperfect-but-legal item is banked.
 *
 * @throws GatewayNotConfigured immediately, untouched — DEGRADED is not a guard failure.
 */
export async function extractSummaries(
  guests: Guest[],
  opts: { path?: string; log?: (m: string) => void } = {},
): Promise<ExtractSummariesResult> {
  const log = opts.log ?? console.log;
  const path = opts.path ?? summariesPath();
  const model = summaryModel();
  const batchSize = summaryBatch();

  const records: Record<string, PersonSummary> = {};
  const keys: Record<string, string> = {};

  // ---- the cache. A model change discards the WHOLE file: one artifact, one `_model`, no mixing.
  let cache = loadSummaries(path);
  if (cache && cache._model !== model) {
    log(
      `summary cache: model changed (${cache._model} → ${model}) — discarding ` +
        `${Object.keys(cache.records).length} stale record(s)`,
    );
    cache = null;
  }

  const askable: Guest[] = [];
  let hits = 0;
  let skipped = 0;
  for (const g of guests) {
    if (!hasEvidence(g)) {
      records[g.personId] = emptySummary(); // nothing to read — not a failure, not cached
      skipped++;
      continue;
    }
    const key = summaryCacheKey(g.personId, model, renderAnswers(g));
    const cached = cache?.records[g.personId];
    if (cached && cache?._keys[g.personId] === key && !cached.flags?.length) {
      records[g.personId] = cached;
      keys[g.personId] = key;
      hits++;
      continue;
    }
    askable.push(g);
  }
  if (skipped) log(`summary: ${skipped} guest(s) with no answers — empty record, not asked`);
  if (hits) log(`summary: ${hits} guest(s) served from ${path} (unchanged answers, same model)`);

  let extracted = 0;
  let failed = 0;
  let droppedInferences = 0;
  let droppedNoEvidence = 0;
  let tolerated = 0;

  const batches = Math.ceil(askable.length / batchSize);
  for (let i = 0; i < askable.length; i += batchSize) {
    const batch = askable.slice(i, i + batchSize);
    const n = i / batchSize + 1;
    const byId = new Map(batch.map((g) => [g.personId, g]));
    const pending = new Map(byId);

    for (let attempt = 1; attempt <= 2 && pending.size > 0; attempt++) {
      const last = attempt === 2;
      const ask = [...pending.values()];
      const violationLines: string[] = [];
      const toleratedLines: string[] = [];
      let items: SummaryItem[];
      try {
        items = await askBatch(ask, model, attempt === 1 ? null : RETRY_NUDGE);
      } catch (err) {
        if (err instanceof GatewayNotConfigured) throw err; // DEGRADED — never swallow
        const msg = err instanceof Error ? `${err.name}: ${err.message.slice(0, 160)}` : String(err);
        console.error(`summary batch ${n}/${batches} attempt ${attempt} FAILED — ${msg}`);
        continue;
      }

      for (const item of items) {
        const guest = pending.get(item.personId);
        if (!guest) {
          if (!byId.has(item.personId)) {
            console.error(`summary batch ${n}: model returned unknown personId "${item.personId}" — dropped`);
          }
          continue;
        }
        const outcome = guardItem(guest, item);
        // Bar 1 on the first ask (perfection is still reachable), bar 2 on the last (the law).
        if (!outcome.record || (outcome.violations.length > 0 && !last)) {
          violationLines.push(`${guest.personId}: ${outcome.violations.join("; ")}`);
          continue; // stays pending
        }
        if (outcome.violations.length) {
          toleratedLines.push(`${guest.personId}: ${outcome.violations.join("; ")}`);
          tolerated++;
        }
        records[guest.personId] = outcome.record;
        keys[guest.personId] = summaryCacheKey(guest.personId, model, renderAnswers(guest));
        droppedInferences += outcome.dropped;
        droppedNoEvidence += outcome.droppedNoEvidence;
        extracted++;
        pending.delete(guest.personId);
      }

      if (violationLines.length) {
        console.error(
          `summary batch ${n} attempt ${attempt}: POST-GUARD rejected ${violationLines.length} item(s)\n  ` +
            violationLines.join("\n  "),
        );
      }
      if (toleratedLines.length) {
        console.error(
          `summary batch ${n}: TOLERATED ${toleratedLines.length} item(s) after the retry — kept the ` +
            `law-clean part, dropped the rest\n  ` + toleratedLines.join("\n  "),
        );
      }
      if (pending.size && attempt === 1) {
        const missing = [...pending.keys()].filter((id) => !items.some((it) => it.personId === id));
        if (missing.length) console.error(`summary batch ${n}: no item returned for ${missing.join(", ")}`);
      }
    }

    for (const guest of pending.values()) {
      markGuest(guest, SUMMARY_GUARD_FAILED_FLAG);
      // NO cache key for a failure: the next run re-asks instead of freezing the failure in.
      records[guest.personId] = emptySummary([SUMMARY_GUARD_FAILED_FLAG]);
      failed++;
    }

    log(
      `summary batch ${n}/${batches}: ${batch.length - pending.size}/${batch.length} extracted` +
        (pending.size ? ` · ${pending.size} ${SUMMARY_GUARD_FAILED_FLAG}` : ""),
    );
  }

  return {
    artifact: {
      _src: SUMMARY_SRC,
      // The model that ACTUALLY produced these records, captured here at extraction time — never
      // re-derived downstream from an env var that may have changed since (law d).
      _model: model,
      _ts: new Date().toISOString(),
      _actor: "agent",
      _keys: keys,
      records,
    },
    askable: askable.length + hits,
    hits,
    extracted,
    failed,
    skipped,
    droppedInferences,
    droppedNoEvidence,
    tolerated,
  };
}

/** Re-exported so a caller can print the cap it ran under without importing two modules. */
export { MAX_QUOTE_WORDS };
