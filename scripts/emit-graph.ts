/**
 * scripts/emit-graph.ts — bake the party into the two artifacts the /graph room serves:
 *
 *   public/graph/graph.json          nodes + edges + per-lens positions + `places` + meta
 *   public/graph/people/<id>.json    one record per guest: their own words, their ranked
 *                                    connections with receipts, their conviction (the computed
 *                                    tags + the verbatim quotes behind them), their `inferred`
 *                                    block (OUR read + OUR labels — the third register, below),
 *                                    their `taste` twins (THE FOURTH BLOCK, below), and their
 *                                    highlights
 *   data/graph-enriched.csv          THE ENRICHMENT SHEET (below) — emitted every run
 *
 * Laws honoured here:
 *  - READ-ONLY against Neo4j. Nothing in this file writes to the graph; the traversal
 *    (`STUDIES_AT` / `WORKS_AT` / `SEEKS`) is the SOURCE of the emitted edges, so what
 *    ships is what the graph actually says — not what the CSV happens to imply.
 *  - No claim without a receipt. Every person-record edge carries the verbatim cells or
 *    quotes behind it; when a side has no quote we OMIT it rather than invent one (the
 *    route then names the honest provenance: "the fields above are the receipt").
 *  - Nothing zero renders. "sought by 0" is absent, never a zero — and no internal flag
 *    ever reaches user-visible copy.
 *  - Dignity floor: every guest leaves with ≥1 connection and ≥3 highlights. 70 people
 *    have nobody seeking them; they still get a full record.
 *  - No PII: emails, phones and Luma links stay in the CSV. scripts/check-graph-emit.ts
 *    re-reads every emitted byte and fails if any of it leaks.
 *
 * Run:
 *   GUESTS_CSV=… node --env-file=.env --import tsx scripts/emit-graph.ts   # the graph bake
 *   FIXTURE=1 GUESTS_CSV=… npx tsx scripts/emit-graph.ts                   # offline bake
 *   npx tsx scripts/check-graph-emit.ts                                    # the gate
 *
 * Env:
 *   GUESTS_CSV      (required) the Luma guest export — answers, raw cells and guest_ids
 *   FIXTURE=1       (optional) OFFLINE FALLBACK: skip Neo4j and derive the structural edges
 *                   from the CSV groupings instead. Same sampling, same output shape; the
 *                   artifact records `meta.source: "fixture-csv"` so nobody can mistake a
 *                   fixture bake for a graph bake.
 *   OVERRIDES_PATH  (optional) the enrichment overrides CSV, default `data/graph-overrides.csv`.
 *                   Point it at a temp file to test the override layer without touching the
 *                   committed baseline.
 *   INFER_EMIT_FLOOR (optional) the confidence floor a LABELLED inference must clear to ship,
 *                   default 0.75. See THE THIRD REGISTER below.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { z } from "zod";
import { loadGuests, type Guest } from "../lib/guests";
import { isConfigured, run, toNum, close, Neo4jNotConfigured } from "../lib/neo4j";
import { webLayout, ringLayout, type Vec2 } from "../lib/layout";
import { VECTOR_PROVIDERS } from "../lib/matches";
import { MOTIVES, MISSIONS, IMPACTS, ASPIRATIONS, MODEL_UNRECORDED } from "../lib/conviction";
import { metroOf, coordOf, PLACE_COORDS_SRC } from "../lib/places";
import { tasteMatches, TASTE_FIELDS, type TasteMatch } from "../lib/taste";

/* ────────────────────────────── inputs + shapes ────────────────────────────── */

const OUT_DIR = "public/graph";
const PEOPLE_DIR = join(OUT_DIR, "people");
const CONVICTIONS = "data/graph-private/convictions.json";
const MATCHES = "data/graph-private/matches.json";
/**
 * OPTIONAL input — see THE THIRD REGISTER. Deliberately NOT in the `InputMissing` list with the
 * two above: an offline/FIXTURE bake, a fresh clone and a design-only run must all still emit a
 * complete room. Absent → every record ships exactly as it did before this leg existed, and the
 * run says so on stdout rather than leaving the difference invisible.
 */
const SUMMARIES = "data/graph-private/summaries.json";

/* ═════════════════════════ THE ENRICHMENT SHEET LOOP ═════════════════════════
 *
 * A managed, human-editable station between the computed pipeline and the baked
 * artifacts — the v2 twin of v1's `data/party.csv` + `data/real-overrides.json`
 * (scripts/precache.ts). Two files, opposite jobs:
 *
 *   data/graph-enriched.csv   WRITTEN by this script on every run. One row per person who
 *                             actually shipped, in emitted (CSV) order, columns pinned to
 *                             SHEET_COLUMNS. It is the read-only proof sheet: everything the
 *                             bake decided about a guest on one line, so a human can SEE the
 *                             tags, the receipts, the ranked matches and the group sizes
 *                             without opening 312 JSON files. Committed like party.csv.
 *                             Never an input — re-deriving it from itself would let a typo
 *                             become data.
 *
 *   data/graph-overrides.csv  READ by this script (or OVERRIDES_PATH). Sparse and
 *                             hand-managed: a header row plus ONLY the people a human had to
 *                             correct. It survives every re-run of the pipeline, because it
 *                             is never regenerated. Columns:
 *
 *       person_id      REQUIRED. Must resolve against the CSV population, or the run FAILS
 *                      (`OverrideSubjectUnknown`) — an override that binds to nobody is a
 *                      silent no-op, and silent is the one thing an override may never be.
 *       motive         one of lib/conviction MOTIVES
 *       mission        one of lib/conviction MISSIONS
 *       impact         one of lib/conviction IMPACTS
 *       aspiration     one of lib/conviction ASPIRATIONS
 *                      → the four tag columns REPLACE the extracted tag. Validated by zod
 *                        against the CLOSED vocabularies: an off-vocabulary value is a named
 *                        error and exit 1, never a coerced near-miss (law b, fail loud).
 *                        A replaced tag then flows through the ONE existing code path —
 *                        tag groups, why-edges, node fields, caucus/motive/craft highlights —
 *                        so an override cannot produce a state the normal bake could not.
 *       pinned_match   a person_id. Moves that person's EXISTING edge to rank 1 of their
 *                      person-record `edges` list. If no such edge exists it is a named
 *                      WARNING, not an error, and nothing is written: this layer reorders
 *                      claims, it never fabricates one (law c — an edge with no traversal
 *                      behind it has no receipt).
 *       hide           true|false. `true` removes the person from EVERY emitted artifact —
 *                      node, edges touching them, other people's match lists, every count.
 *                      Applied BEFORE the graph read, so counts and highlights are derived
 *                      from the surviving population and stay consistent by construction.
 *                      NOTE: hide genuinely changes the population, so the pinned population
 *                      constants fire — `EXPECTED_PEOPLE` in scripts/check-graph-emit.ts and
 *                      the CSV-derived population in scripts/audit-graph.ts. That is the
 *                      gates working: removing a guest is a decision that must be declared,
 *                      not absorbed.
 *       host_notes     free text. Echo-through only — never read by any renderer.
 *
 *   QUOTES ARE NOT OVERRIDABLE. A receipt is byte-verbatim from the guest's own answer or it
 *   is not a receipt (law c), and nothing typed into a spreadsheet is verbatim by
 *   construction. When a tag is replaced, the quote that stood behind the OLD tag stops being
 *   evidence for the new one, so it is DROPPED — from the sheet column, and from the
 *   conviction the bake reads, unless a tag we did not touch still cites that same answer
 *   field. A tag with no quote is a supported downstream state; a tag with the wrong quote is
 *   a fabricated receipt.
 *
 *   Every applied override is stamped `_overridden: ["mission", …]` on the person record and
 *   on the graph node, and summarized on stdout. "Why does it say that?" stays answerable
 *   from the artifact alone (law d).
 * ════════════════════════════════════════════════════════════════════════════ */

const ENRICHED_SHEET = "data/graph-enriched.csv";
const OVERRIDES_PATH = process.env.OVERRIDES_PATH?.trim() || "data/graph-overrides.csv";

/**
 * The pinned column order of data/graph-enriched.csv. check-graph-emit.ts asserts it exactly.
 *
 * The last two are PROVENANCE columns and they are echoes, never derivations: `extraction_model`
 * is whatever data/graph-private/convictions.json recorded as its `_model` (or "unrecorded" for a
 * cache written before the stamp existed), and `match_provider` is matches.json's own
 * `_provider`. Neither is read from the environment at bake time — see readConvictions/readMatches.
 */
const SHEET_COLUMNS = [
  "person_id", "guest_id", "name", "title", "company", "is_freelance", "school", "class_year",
  "hometown", "metro", "instagram",
  "motive", "mission", "impact", "aspiration", "open_seeker",
  "motive_quote", "mission_quote", "impact_quote",
  "school_node", "company_node", "craft_node",
  "conviction_groups",
  "match_1", "match_2", "match_3", "match_4", "match_5",
  "inbound_count", "mutual_with", "doppelganger", "doppelganger_score",
  "pinned_match", "hide", "host_notes",
  "flags", "extraction_model", "match_provider",
] as const;

/** The pinned column order of data/graph-overrides.csv (its header row, and nothing else). */
const OVERRIDE_COLUMNS = [
  "person_id", "motive", "mission", "impact", "aspiration", "pinned_match", "hide", "host_notes",
] as const;

const OVERRIDABLE_TAGS = ["motive", "mission", "impact", "aspiration"] as const;
type OverridableTag = (typeof OVERRIDABLE_TAGS)[number];

/**
 * The answer field each tag's receipt is drawn from — mirrors the extraction prompt in
 * lib/conviction.ts ("motive … mostly from `drew`"; mission/impact/aspiration are read off
 * `goal`). It is what makes "drop the quote behind a replaced tag" a precise operation
 * instead of a guess: conviction quotes are keyed by ANSWER FIELD, tags are not.
 */
const TAG_QUOTE_FIELD: Record<OverridableTag, string> = {
  motive: "drew",
  mission: "goal",
  impact: "goal",
  aspiration: "goal",
};

/**
 * The tags that ship a receipt — the sheet's three quote columns, and the same three in the
 * person record's `conviction.quotes`. `aspiration` reads off `goal` like mission/impact do, so
 * a fourth column would only ever restate one of theirs; it has never carried one, and the
 * record does not invent one.
 */
const QUOTED_TAGS: readonly OverridableTag[] = ["motive", "mission", "impact"];

/** mirrors the two raw columns lib/guests.ts canonicalizes — receipts quote the RAW cell */
const RAW_COL = {
  school: "School? (e.g. USC '27)",
  company: 'Company? (if you are freelance, just say "creative")',
} as const;

const ConvictionSchema = z.object({
  motive: z.string().nullable(),
  mission: z.string().nullable(),
  impact: z.string().nullable(),
  aspiration: z.string().nullable(),
  quotes: z.record(z.string(), z.string()),
  openSeeker: z.boolean(),
  /** present only when the conviction post-guard failed twice — surfaced in the sheet's `flags` */
  flags: z.array(z.string()).optional(),
});
const ConvictionsFlatSchema = z.record(z.string(), ConvictionSchema);
/**
 * The conviction artifact carries its own provenance (law d) and nests the records under
 * `convictions`. `_model` is the model that ACTUALLY tagged these people, recorded by
 * scripts/enrich-convictions.ts at extraction time; this leg ECHOES it and never asks the
 * environment. Extra provenance keys (`_src`, `_ts`, `_actor`) are read past, not required —
 * `_model` is the one this leg makes a claim out of.
 */
const ConvictionsArtifactSchema = z.object({
  _model: z.string().min(1),
  convictions: ConvictionsFlatSchema,
});

/**
 * The conviction cache, plus what it attests about itself.
 *
 * THE LEGACY FLAT SHAPE IS STILL READ, AND IT IS READ HONESTLY. The standing cache predates the
 * `_model` stamp: it is a bare `Record<personId, Conviction>` that records nothing about which
 * model produced it. That file is not re-runnable on demand — the tags are calibrated and 51
 * overrides in data/graph-overrides.csv are pinned to them — so this leg keeps baking from it and
 * reports {@link MODEL_UNRECORDED} rather than filling the gap.
 *
 * Filling it was the alternative, and it is the one to refuse. The as-built departure report says
 * the pass ran on Haiku 4.5, so stamping that string here would even be CORRECT — but it would be
 * this leg asserting, from a document, a fact about a run it did not observe, which is precisely
 * the shape of the bug being deleted (the `extraction_model` column said gpt-4o-mini for 312 rows
 * because emit re-read `CONVICTION_MODEL` at bake time). An artifact may only attest what it can
 * support. "unrecorded" is supportable; the report stays where a human can read it.
 */
function readConvictions(raw: unknown): { model: string; records: Record<string, Conviction> } {
  const isEnvelope =
    Boolean(raw) && typeof raw === "object" && !Array.isArray(raw) && "convictions" in (raw as object);
  if (isEnvelope) {
    const a = ConvictionsArtifactSchema.parse(raw);
    return { model: a._model, records: a.convictions };
  }
  return { model: MODEL_UNRECORDED, records: ConvictionsFlatSchema.parse(raw) };
}

const MatchesBodySchema = z.object({
  seeks: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      score: z.number(),
      mutual: z.boolean(),
      via: z.string(),
    }),
  ),
  doppels: z.array(z.object({ a: z.string(), b: z.string(), score: z.number() })),
});

/**
 * The seek matrix, plus the vector space it was computed in — echoed from `_provider`, which
 * scripts/enrich-matches.ts stamps at computation time.
 *
 * AN UNRECORDED PROVIDER IS FATAL HERE, unlike the conviction model above, and the asymmetry is
 * the point rather than an inconsistency. `meta.matchProvider` is a load-bearing claim that
 * scripts/check-graph-emit.ts asserts is one of two real values, and it says which vector space
 * decided who should find whom — a bake that cannot answer that is shipping a room it cannot
 * account for. And the remedy is free: re-running scripts/enrich-matches.ts under
 * `EMBED_PROVIDER=tfidf` is offline, deterministic, and costs nothing, where re-running the
 * conviction pass would burn the calibrated tags the overrides are pinned to. Fail loud where the
 * fix is a re-run; label honestly where it is not.
 */
function readMatches(raw: unknown): { provider: string; seeks: SeekRow[]; doppels: DoppelRow[] } {
  const body = MatchesBodySchema.parse(raw);
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>)._provider : undefined;
  if (typeof p !== "string" || !(VECTOR_PROVIDERS as readonly string[]).includes(p)) {
    throw new EmitError(
      "MatchProviderUnrecorded",
      `${MATCHES} does not record which vector space produced it (_provider is ${JSON.stringify(p)}, ` +
        `expected one of ${VECTOR_PROVIDERS.join(" | ")}). This leg echoes the matrix's own ` +
        `provenance and will not attest a provider it cannot read — re-run scripts/enrich-matches.ts ` +
        `(EMBED_PROVIDER=tfidf needs no gateway and is deterministic) to stamp it.`,
    );
  }
  return { provider: p, seeks: body.seeks, doppels: body.doppels };
}

type Conviction = z.infer<typeof ConvictionSchema>;
type SeekRow = z.infer<typeof MatchesBodySchema>["seeks"][number];
type DoppelRow = z.infer<typeof MatchesBodySchema>["doppels"][number];

/* ═════════════════════════════ THE THIRD REGISTER ═════════════════════════════
 *
 * A person record carries three kinds of claim, and they are SEPARATE KEYS FOREVER:
 *
 *   register 1  what the guest STATED      `answers` (verbatim) + `conviction` (tags they
 *                                          literally named, with their own quotes behind them)
 *   register 2  what WE READ into it       `inferred.summary` — one distilled line, ours
 *   register 3  what WE LABELLED them as   `inferred.mission` / `inferred.impact` — our guess
 *                                          at the same closed vocabularies register 1 uses
 *
 * Registers 2 and 3 ride in ONE `inferred` block that is a SIBLING of `conviction`, never a key
 * inside it. That is the whole point: a card rendering `conviction.mission` is quoting the guest,
 * a card rendering `inferred.mission` is quoting US, and no consumer can confuse the two by
 * accident because they never share a container. Nothing here touches `conviction`'s keys, the
 * graph.json nodes, or the enrichment sheet — the node tags and the sheet's `mission` column stay
 * register 1, so every count, caucus, why-edge and override in this file keeps meaning exactly
 * what it meant before. An inference that could re-cut the room would be an inference pretending
 * to be a fact.
 *
 * WHAT SHIPS (law c — no claim without a receipt):
 *  - every summary and every label carries >=1 evidence span, and every span is re-verified HERE
 *    against the guest's own CSV answer before it is written. `lib/summarize.ts` already snapped
 *    them, but the artifact is a separate file that can go stale against the CSV being baked, and
 *    a receipt that no longer resolves is a fabricated receipt. A span that fails is a NAMED
 *    error and exit 2, never a silent drop.
 *  - THE RENDER FLOOR. `lib/summarize.ts` stores a label at confidence >= 0.60 (its own prompt's
 *    "clearly implied by specific language" band). This leg ships at a STRICTER floor, because
 *    "worth keeping in a private artifact" and "worth showing a guest as our read of them" are
 *    different bars. Pinned to 0.75 by reading the labels, not by taste: every one of the 20
 *    inferred `craft-excellence` missions was inspected, and the defective ones all sit below
 *    0.75 — careers read as missions ("Being a director for an animated feature"), a medium read
 *    as a mission ("Computer Graphics"), and the documented over-reach where a guest was labelled
 *    from an achievement they admired in SOMEONE ELSE (an `inspiration` span about another
 *    person's show, 0.72). At and above 0.75 the labels stand on the guest's own words about
 *    their own work. The floor is a policy knob, so it is env-overridable — but it is not a
 *    substitute for the guards upstream, and lowering it re-admits the over-reach.
 *  - `_src`/`_model` are ECHOED FROM THE ARTIFACT (law d). The model that produced these records
 *    is a fact about the extraction run, recorded at extraction time; re-deriving it here from an
 *    env var that may have changed since would make the provenance a guess. This is now the
 *    pattern, not the exception: the sheet's `extraction_model` and `match_provider` columns and
 *    `meta.matchProvider` are all echoes of what their own artifacts recorded (see
 *    `readConvictions` / `readMatches`). Nothing in this file asks the environment who did the
 *    work — it used to, and it spent an entire bake attesting a model that never ran.
 * ═════════════════════════════════════════════════════════════════════════════ */

/** The four answer fields shown to the summary pass — therefore the only fields a span may cite. */
const INFER_EVIDENCE_FIELDS = ["goal", "drew", "seeking", "inspiration"] as const;

/** Default render floor. See THE THIRD REGISTER for why it is 0.75 and not the artifact's 0.60. */
const INFER_EMIT_FLOOR_DEFAULT = 0.75;

/**
 * Read at CALL time, not import time. An unparseable or out-of-range override is a NAMED error,
 * never a silent fall back to the default: a floor nobody can trust is worse than no floor.
 */
function inferEmitFloor(): number {
  const raw = process.env.INFER_EMIT_FLOOR?.trim();
  if (!raw) return INFER_EMIT_FLOOR_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new EmitError("InferFloorInvalid", `INFER_EMIT_FLOOR=${JSON.stringify(raw)} is not a number in 0..1`);
  }
  return n;
}

const InferEvidenceSchema = z.object({
  field: z.enum(INFER_EVIDENCE_FIELDS), // an off-field span is unrepresentable
  quote: z.string().min(1),
});
/** Range-bound HERE so a corrupt artifact fails at the boundary, not in a downstream renderer. */
const InferConfidence = z.number().min(0).max(1);
const InferSummarySchema = z.object({
  text: z.string().min(1),
  confidence: InferConfidence,
  evidence: z.array(InferEvidenceSchema),
});
const InferClaimSchema = <T extends readonly [string, ...string[]]>(vocab: T) =>
  z.object({
    value: z.enum(vocab), // the SAME closed vocabularies register 1 is bounded by
    confidence: InferConfidence,
    evidence: z.array(InferEvidenceSchema),
  });
const SummaryRecordSchema = z.object({
  summary: InferSummarySchema.nullable(),
  inferred: z.object({
    mission: InferClaimSchema(MISSIONS).nullable(),
    impact: InferClaimSchema(IMPACTS).nullable(),
  }),
  /** present only when the summary post-guard failed twice — such a record has nothing to ship */
  flags: z.array(z.string()).optional(),
});
/**
 * Records are nested under `records` (never flat at the root), so `Object.entries` can never hand
 * this leg a provenance string where a record is expected. `_keys` is the pass's own incremental
 * cache and is deliberately not read here.
 */
const SummariesArtifactSchema = z.object({
  _src: z.string().min(1),
  _model: z.string().min(1),
  _ts: z.string().min(1),
  _actor: z.string().min(1),
  records: z.record(z.string(), SummaryRecordSchema),
});
type SummariesArtifact = z.infer<typeof SummariesArtifactSchema>;

interface InferredEvidenceOut {
  field: string;
  quote: string;
}
interface InferredClaimOut {
  value: string;
  confidence: number;
  evidence: InferredEvidenceOut[];
}
interface InferredSummaryOut {
  text: string;
  confidence: number;
  evidence: InferredEvidenceOut[];
}
/** The emitted block. `_src`/`_model` are mandatory: an unattributed read is not shippable. */
interface InferredOut {
  summary?: InferredSummaryOut;
  mission?: InferredClaimOut;
  impact?: InferredClaimOut;
  _src: string;
  _model: string;
}

/**
 * Absent → null (the OPTIONAL contract). Present but malformed → a NAMED error, because an
 * artifact that exists and cannot be trusted is not the same thing as an artifact that is not
 * there: the first is a broken pipeline stage and must stop the bake, the second is an offline
 * run. (`lib/summarize.ts` treats a bad file as "no cache" — that is a CACHE reading it; this is
 * a SHIPPING reading of it, and it fails closed.)
 */
function loadSummaries(path: string): SummariesArtifact | null {
  if (!existsSync(path)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new EmitError("SummariesUnreadable", `${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = SummariesArtifactSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((is) => `${is.path.join(".") || "<root>"}: ${is.message}`)
      .join(" | ");
    throw new EmitError("SummariesUnreadable", `${path} is off-contract — ${issues}`);
  }
  return parsed.data;
}

/* ═══════════════════ THE FOURTH BLOCK: taste, and the places array ═══════════════════
 *
 * Two additions that add no register and no edge type — they are DERIVED FACTS about what the
 * guests already said, and they live where nobody can mistake them for something else.
 *
 * `taste` — a SIBLING of `conviction` and `inferred` on the person record, one key per matched
 * field (`favorite` / `inspiration`; see lib/taste.ts for the exact-match law and the
 * placeholder exclusion). It is deliberately NOT a fifth edge type: the route's badge maps key
 * on {school, company, why, seek} and render `MATCH · undefined` for anything else, and a badge
 * that cannot name its own kind is a provenance lie. It is also deliberately NOT a highlight:
 * `highlights` is capped at 6 and already evicts hometown for 117 people, so a taste line would
 * ship by pushing a truer line off the end. A block of its own costs nobody anything.
 * Both sides carry the OTHER person's cell byte-for-byte, so the claim "you both wrote this"
 * is provable from the two records alone (law c).
 *
 * `places` — a TOP-LEVEL array in graph.json, `{name, lat?, lng?, n, personIds}`, derived EVERY
 * BAKE from the surviving population's metros (lib/places.ts). Counts are consistent by
 * construction: `n === personIds.length`, every id is an emitted node, and `hide` flows through
 * for free because this is built from `nodes`, not from the CSV. It replaces the only geocoded
 * hometown table the room has ever had — a 50-pin array vendored into app/graph/pepl/adapter.ts
 * whose counts and people arrays date from a different guest list.
 *
 * A METRO WITH NO COORDINATE STILL SHIPS. 171 metros, 89 of them in the vendored coordinate
 * table; the other 82 appear in `places` with their real `n` and `personIds` and NO `lat`/`lng`
 * keys at all. Dropping them would make `places` disagree with the population it was derived
 * from — a map that cannot draw a place is a limit of the map, not a reason to un-count eight
 * people from Sherman Oaks. A renderer draws what has coordinates; every consumer can still
 * count what does not.
 * ═════════════════════════════════════════════════════════════════════════════════════ */

type EdgeType = "school" | "company" | "why" | "seek";
type Direction = "mutual" | "inbound" | "outbound";

interface GEdge {
  s: string;
  t: string;
  type: EdgeType;
  via: string;
  m?: boolean;
  score?: number;
}
interface Receipt {
  field: string;
  quote: string;
}
interface PersonEdge {
  targetId: string;
  type: EdgeType;
  direction?: Direction;
  strength?: number;
  via: string;
  receipt?: { yours?: Receipt; theirs?: Receipt };
}
interface Highlight {
  kind: string;
  text: string;
  targets?: string[];
}
/**
 * The person record's copy of the conviction: the computed "who we think you are", in its
 * POST-OVERRIDE state, so a card can render it (and its receipts) without a second fetch.
 * Every key is optional and an empty one is OMITTED, never emitted blank — nothing zero
 * renders. `quotes` is byte-verbatim from the guest's own answer; a tag a human overrode has
 * no quote at all (the override law above: the old receipt stopped being evidence).
 */
interface ConvictionOut {
  motive?: string;
  mission?: string;
  impact?: string;
  aspiration?: string;
  quotes?: Record<string, string>;
}
/** an emitted graph.json node — `_overridden` appears only when a human moved one of its tags */
interface GraphNodeOut {
  id: string;
  name: string;
  title: string;
  school: string | null;
  company: string | null;
  free: boolean;
  /** the guest's own "Hometown?" cell, verbatim. A display-safe, non-contact field: it rides
      on the node so a surface can say where someone is from WITHOUT waiting on (or being
      silently truncated out of) the person record — `highlights` is capped at 6, so 117
      people with a real hometown carry no hometown highlight. audit-graph checks it
      byte-for-byte against the CSV like every other node field, and check-graph-emit
      asserts its shape and coverage offline. */
  hometown: string | null;
  /** the normalized metro `hometown` resolves to (lib/places.ts) — the key `places` groups on,
      and the reason "Los Angeles" is one cohort of 57 instead of ten spellings. DERIVED, and it
      ships next to the cell it was derived from: `hometown` is this field's receipt, so a
      surface that renders the metro can always show the guest's own words for it. null exactly
      when `hometown` is null. */
  metro: string | null;
  motive: string | null;
  mission: string | null;
  impact: string | null;
  asp: string | null;
  deg: number;
  pos: { web: Vec2; why: Vec2; seek: Vec2 };
  _overridden?: string[];
}
/**
 * One metro in graph.json's top-level `places`. `lat`/`lng` are OMITTED — not null, not 0/0 —
 * when the vendored table has no coordinate for the name: an absent key is an absence a
 * renderer cannot accidentally plot, where `0,0` is the Gulf of Guinea.
 */
interface PlaceOut {
  name: string;
  lat?: number;
  lng?: number;
  n: number;
  personIds: string[];
}
/** a person as the SOURCE says they are (the graph in the default path, the CSV in FIXTURE) */
interface SourcePerson {
  id: string;
  name: string;
  title: string;
  school: string | null;
  company: string | null;
}

class EmitError extends Error {
  constructor(name: string, message: string) {
    super(`${name}: ${message}`);
    this.name = name;
  }
}

/* ─────────────────────────── the overrides layer ─────────────────────────── */

/**
 * The four tag columns are `z.enum`s over the SAME closed vocabularies the extraction is
 * bounded by (lib/conviction.ts), so an off-vocabulary override is UNREPRESENTABLE — the
 * same grounding-by-construction trick as the ontology gate, applied to a spreadsheet.
 */
const OverrideRowSchema = z.object({
  person_id: z.string().min(1),
  motive: z.enum(MOTIVES).optional(),
  mission: z.enum(MISSIONS).optional(),
  impact: z.enum(IMPACTS).optional(),
  aspiration: z.enum(ASPIRATIONS).optional(),
  pinned_match: z.string().min(1).optional(),
  hide: z.boolean().optional(),
  host_notes: z.string().optional(),
});
type OverrideRow = z.infer<typeof OverrideRowSchema>;

const TRUE_WORDS = new Set(["true", "1", "yes", "y"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n"]);

/**
 * Read + validate data/graph-overrides.csv. Absent file → empty layer (the sheet loop is
 * optional). Present but malformed → a NAMED error, never a partially-applied override set:
 * half an override is worse than none, because nobody can tell which half landed.
 */
function loadOverrides(path: string): Map<string, OverrideRow> {
  const rows = new Map<string, OverrideRow>();
  if (!existsSync(path)) return rows;

  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => (h.charCodeAt(0) === 0xfeff ? h.slice(1) : h).trim(),
  });
  if (parsed.errors.length > 0) {
    const sample = parsed.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join(" | ");
    throw new EmitError("OverridesUnparseable", `${path}: ${parsed.errors.length} CSV error(s) — ${sample}`);
  }

  // A misspelled column is a silent no-op in every CSV reader ever written. Not here.
  const headers = (parsed.meta.fields ?? []).filter((h) => h !== "");
  const unknown = headers.filter((h) => !(OVERRIDE_COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0) {
    throw new EmitError(
      "OverrideColumnUnknown",
      `${path} has column(s) outside the contract: ${unknown.join(", ")} — allowed: ${OVERRIDE_COLUMNS.join(", ")}`,
    );
  }
  if (headers.length > 0 && !headers.includes("person_id")) {
    throw new EmitError("OverrideColumnUnknown", `${path} has no person_id column — every override names its subject`);
  }

  for (const [i, raw] of parsed.data.entries()) {
    const line = i + 2; // 1-based, past the header — the number the editor's cursor is on
    const cells: Record<string, string> = {};
    for (const k of OVERRIDE_COLUMNS) {
      const v = (raw[k] ?? "").trim();
      if (v !== "") cells[k] = v;
    }
    if (Object.keys(cells).length === 0) continue; // a blank line is not an override
    if (!cells.person_id) {
      throw new EmitError("OverrideSubjectMissing", `${path} line ${line} sets values but names no person_id`);
    }

    const candidate: Record<string, unknown> = { ...cells };
    if (cells.hide !== undefined) {
      const h = cells.hide.toLowerCase();
      if (TRUE_WORDS.has(h)) candidate.hide = true;
      else if (FALSE_WORDS.has(h)) candidate.hide = false;
      else {
        throw new EmitError(
          "OverrideValueInvalid",
          `${path} line ${line}: hide=${JSON.stringify(cells.hide)} is neither true nor false`,
        );
      }
    }

    const res = OverrideRowSchema.safeParse(candidate);
    if (!res.success) {
      const issues = res.error.issues
        .map((is) => `${is.path.join(".") || "<row>"}: ${is.message}`)
        .join(" | ");
      throw new EmitError(
        "OverrideValueInvalid",
        `${path} line ${line} (${cells.person_id}) is off-vocabulary — ${issues}`,
      );
    }
    if (rows.has(res.data.person_id)) {
      throw new EmitError(
        "OverrideDuplicateSubject",
        `${path}: ${res.data.person_id} appears twice — one row per person, or nobody can say which one won`,
      );
    }
    rows.set(res.data.person_id, res.data);
  }
  return rows;
}

/* ─────────────────────────── tag vocabulary → English ─────────────────────────── */
// The conviction vocabularies are closed (task-4 extraction). These maps turn a tag into
// a sentence a guest would actually read; an unfamiliar tag falls back to its own words
// (never invented) and is reported on stderr so the vocabulary drift is visible.

const MOTIVE_PHRASE: Record<string, string> = {
  "craft-obsession": "an obsession with the craft",
  "storytelling-urge": "the urge to tell stories",
  "fandom-turned-maker": "fandom that turned into making",
  "childhood-immersion": "growing up inside it",
  "community-belonging": "wanting to find their people",
  "music-first": "music first",
  "performance-joy": "the joy of performing",
  "representation-gap": "wanting to see themselves on screen",
  "accident-pivot": "a happy accident",
  "family-industry": "family already in the industry",
  escape: "wanting somewhere to escape to",
  "games-first": "games first",
};
const MISSION_PHRASE: Record<string, string> = {
  "build-community": "build community",
  "representation-feel-seen": "put people like them on screen",
  "inspire-next-gen": "inspire whoever comes next",
  "joy-positivity": "put more joy into the world",
  "elevate-underdogs": "elevate the underdogs",
  "preserve-stories": "preserve stories",
  "truth-inform": "tell the truth",
  "prove-its-possible": "prove it is possible",
  "champion-artists": "champion artists",
  "wonder-escape": "build somewhere to escape to",
  "craft-excellence": "get the craft right",
};
const IMPACT_PHRASE: Record<string, string> = {
  "connect-people": "connect people",
  "inspire-action": "make people act",
  "make-people-feel-seen": "make people feel seen",
  "bring-joy": "bring joy",
  "create-escape-wonder": "create wonder",
  "keep-stories-alive": "keep stories alive",
  "provoke-thought": "provoke thought",
  "inform-truth": "inform",
};
const ASP_PHRASE: Record<string, string> = {
  direct: "direct",
  produce: "produce",
  "market-brand": "build brands",
  "represent-agency": "represent talent",
  design: "design",
  "executive-pm": "run the projects",
  write: "write",
  "compose-music": "compose",
  act: "act",
  journalism: "report",
  cinematography: "shoot",
  "entertainment-law": "practise entertainment law",
  photography: "shoot stills",
  casting: "cast",
  edit: "edit",
  undecided: "figure out where they land",
};

const unknownTags = new Set<string>();
const pretty = (tag: string) => tag.replace(/[_-]+/g, " ");
function phraseOf(map: Record<string, string>, tag: string, kind: string): string {
  const p = map[tag];
  if (p) return p;
  unknownTags.add(`${kind}:${tag}`);
  return pretty(tag);
}

/* ───────────────────────────────── small helpers ───────────────────────────────── */

/**
 * The class year a guest wrote INSIDE their school cell ("USC '27" → "27") — the exact token
 * `canonSchool` strips to reach the School node name, mirrored here so the sheet can show
 * both halves of that split. Empty when they wrote no year. Digits verbatim, never widened
 * to a four-digit year we were not given.
 */
function classYearOf(rawSchool: string): string {
  const first = (rawSchool.includes("/") ? rawSchool.split("/")[0] : rawSchool).trim();
  const m = /[’'`‘]?\s*(\d{2,4})\s*[’'‘]?\s*$/u.exec(first);
  return m ? m[1] : "";
}

/** a prefix of the guest's own words — never an ellipsis, so it stays a verbatim substring */
function clip(s: string, max = 240): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return s.slice(0, cut > 80 ? cut : max);
}

const STOP = new Set(
  ("the and a to of i in that it is for with my me on was at be this have are as but not you they we so " +
    "just really want people would get like who what how from about into more them their there when will " +
    "make making being able very much also our out can could than then were where which while your")
    .split(/\s+/),
);
function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9']+/)) if (w.length > 3 && !STOP.has(w)) out.add(w);
  return out;
}
/** cosine-ish overlap of two token sets — deterministic, offline, good enough for "nearest" */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits += 1;
  return hits / Math.sqrt(a.size * b.size);
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * The prototype's ring + chord sampling: a group of ≤6 draws every pair; anything
 * bigger draws a ring (each member → the next) plus the half-way chord. 70 people from
 * USC become ~105 legible threads instead of 2,415 solid grey.
 */
function sampleGroup(members: readonly string[]): [string, string][] {
  const n = members.length;
  if (n < 2) return [];
  const out = new Map<string, [string, string]>();
  const add = (a: string, b: string) => {
    if (a === b) return;
    const k = pairKey(a, b);
    if (!out.has(k)) out.set(k, a < b ? [a, b] : [b, a]);
  };
  if (n <= 6) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) add(members[i], members[j]);
    return [...out.values()];
  }
  const half = Math.floor(n / 2);
  for (let i = 0; i < n; i++) {
    add(members[i], members[(i + 1) % n]);
    add(members[i], members[(i + half) % n]);
  }
  return [...out.values()];
}

function groupBy(people: readonly SourcePerson[], key: "school" | "company"): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of people) {
    const v = p[key];
    if (!v) continue;
    const arr = m.get(v);
    if (arr) arr.push(p.id);
    else m.set(v, [p.id]);
  }
  for (const arr of m.values()) arr.sort(); // deterministic ring order
  return m;
}

/* ──────────────────────────────── the two sources ──────────────────────────────── */

interface SourceRead {
  label: "neo4j" | "fixture-csv";
  people: SourcePerson[];
  seeks: SeekRow[];
  /** structural pair rows the traversal returned (neo4j only) — used to prove the sampling input */
  traversedPairs: { school: number; company: number } | null;
}

const PEOPLE_CYPHER = `
MATCH (p:Person) WHERE p.id IN $ids
OPTIONAL MATCH (p)-[:STUDIES_AT]->(s:School)
OPTIONAL MATCH (p)-[:WORKS_AT]->(c:Company)
RETURN p.id AS id, p.name AS name, p.position AS title, s.name AS school, c.name AS company
`.trim();

const PAIRS_CYPHER = (rel: string, label: string) =>
  `
MATCH (a:Person)-[:${rel}]->(x:${label})<-[:${rel}]-(b:Person)
WHERE a.id IN $ids AND b.id IN $ids AND a.id < b.id
RETURN a.id AS a, b.id AS b, x.name AS via
`.trim();

const SEEKS_CYPHER = `
MATCH (a:Person)-[k:SEEKS]->(b:Person)
WHERE a.id IN $ids AND b.id IN $ids
RETURN a.id AS a, b.id AS b, k.score AS score, k.mutual AS mutual, k.via AS via
`.trim();

async function readFromGraph(ids: string[]): Promise<SourceRead> {
  if (!isConfigured()) {
    const missing = ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"].filter((k) => !process.env[k]);
    throw new Neo4jNotConfigured(missing);
  }
  const idSet = new Set(ids);

  const peopleRes = await run(PEOPLE_CYPHER, { ids });
  const people: SourcePerson[] = peopleRes.records.map((r) => ({
    id: String(r.get("id")),
    name: String(r.get("name") ?? ""),
    title: String(r.get("title") ?? ""),
    school: (r.get("school") as string | null) ?? null,
    company: (r.get("company") as string | null) ?? null,
  }));
  const got = new Set(people.map((p) => p.id));
  const missing = ids.filter((i) => !got.has(i));
  if (missing.length > 0) {
    throw new EmitError(
      "GraphPopulationMismatch",
      `${people.length} of ${ids.length} v2 people are in Neo4j — missing ${missing.length} (${missing.slice(0, 5).join(", ")}). Run scripts/ingest-guests.ts first.`,
    );
  }
  if (people.length !== ids.length) {
    throw new EmitError(
      "GraphPopulationMismatch",
      `Neo4j returned ${people.length} rows for ${ids.length} ids — a Person id is duplicated`,
    );
  }

  // The traversal the emitted structural edges are sampled FROM. Both endpoints are
  // pinned to the v2 population: the database also holds a legacy 193-person set that
  // shares School/Company nodes, and un-filtered pairs would drag strangers into the room.
  const [schoolPairs, companyPairs] = await Promise.all([
    run(PAIRS_CYPHER("STUDIES_AT", "School"), { ids }),
    run(PAIRS_CYPHER("WORKS_AT", "Company"), { ids }),
  ]);
  const strayPair = [...schoolPairs.records, ...companyPairs.records].find(
    (r) => !idSet.has(String(r.get("a"))) || !idSet.has(String(r.get("b"))),
  );
  if (strayPair) {
    throw new EmitError("PopulationLeak", `a traversed pair left the v2 population: ${strayPair.get("a")} ↔ ${strayPair.get("b")}`);
  }

  const seekRes = await run(SEEKS_CYPHER, { ids });
  const seeks: SeekRow[] = seekRes.records.map((r) => ({
    from: String(r.get("a")),
    to: String(r.get("b")),
    score: toNum(r.get("score")),
    mutual: Boolean(r.get("mutual")),
    via: String(r.get("via") ?? "seeks their craft"),
  }));
  if (seeks.length === 0) {
    throw new EmitError(
      "SeekEdgesMissing",
      "the graph holds no SEEKS relationships for the v2 population — run scripts/enrich-matches.ts before emitting",
    );
  }

  return {
    label: "neo4j",
    people,
    seeks,
    traversedPairs: { school: schoolPairs.records.length, company: companyPairs.records.length },
  };
}

function readFromFixture(guests: readonly Guest[], seeks: SeekRow[]): SourceRead {
  return {
    label: "fixture-csv",
    people: guests.map((g) => ({
      id: g.personId,
      name: g.name,
      title: g.title,
      school: g.school,
      company: g.company,
    })),
    seeks,
    traversedPairs: null,
  };
}

/* ─────────────────────────────────── the bake ─────────────────────────────────── */

async function main(): Promise<number> {
  const csvPath = process.env.GUESTS_CSV;
  if (!csvPath) throw new EmitError("GuestsCsvMissing", "set GUESTS_CSV to the guest export path");
  for (const f of [csvPath, CONVICTIONS, MATCHES]) {
    if (!existsSync(f)) throw new EmitError("InputMissing", `${f} does not exist`);
  }

  /* ---- 1. the inputs ---- */
  const allGuests = loadGuests(csvPath);

  /* ---- 1b. the enrichment overrides, applied BEFORE anything is assembled ----
   * hide has to land before the graph read (the traversal is scoped to the population we
   * emit), and the tag replacements have to land before the tag groups are built, so that
   * an override travels the ONE code path a computed tag travels. */
  const overrides = loadOverrides(OVERRIDES_PATH);
  const strangers = [...overrides.keys()].filter((id) => !allGuests.some((g) => g.personId === id));
  if (strangers.length > 0) {
    throw new EmitError(
      "OverrideSubjectUnknown",
      `${OVERRIDES_PATH} names ${strangers.length} person_id(s) absent from the CSV population: ${strangers.slice(0, 5).join(", ")}`,
    );
  }
  const hiddenIds = new Set([...overrides.values()].filter((r) => r.hide === true).map((r) => r.person_id));

  const guests = hiddenIds.size > 0 ? allGuests.filter((g) => !hiddenIds.has(g.personId)) : allGuests;
  const byGuestId = new Map(guests.map((g) => [g.personId, g] as const));
  const ids = guests.map((g) => g.personId);
  if (ids.length === 0) throw new EmitError("PopulationEmpty", `every guest is hidden by ${OVERRIDES_PATH}`);

  // raw CSV cells (school/company receipts quote the cell, not the canonical name) +
  // the stage counts the entry theatre narrates
  let csvText = readFileSync(csvPath, "utf8");
  if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => (h.charCodeAt(0) === 0xfeff ? h.slice(1) : h),
  });
  const rowCount = parsed.data.length;
  const approvedCount = parsed.data.filter((r) => (r.approval_status ?? "").trim().toLowerCase() === "approved").length;
  const rawByGuestId = new Map<string, Record<string, string>>();
  for (const r of parsed.data) {
    const gid = (r.guest_id ?? "").trim();
    if (gid && !rawByGuestId.has(gid)) rawByGuestId.set(gid, r);
  }
  const rawCell = (g: Guest, col: keyof typeof RAW_COL): string =>
    (rawByGuestId.get(g.guestId)?.[RAW_COL[col]] ?? "").trim();
  const schoolCellMisses = guests.filter((g) => g.school && !rawCell(g, "school")).length;
  const companyCellMisses = guests.filter((g) => g.company && !rawCell(g, "company")).length;
  if (schoolCellMisses > 0 || companyCellMisses > 0) {
    throw new EmitError(
      "RawCellsUnavailable",
      `${schoolCellMisses} school / ${companyCellMisses} company receipts have no raw cell — the CSV headers moved (RAW_COL is stale)`,
    );
  }

  // Both artifacts are read for their PROVENANCE as well as their contents: `extraction_model`
  // and `match_provider` are echoes of what these files recorded about themselves, never an env
  // read at bake time (law d — see readConvictions/readMatches).
  const convictionsFile = readConvictions(JSON.parse(readFileSync(CONVICTIONS, "utf8")));
  const convictions: Record<string, Conviction> = convictionsFile.records;
  const extractionModel = convictionsFile.model;
  const matches = readMatches(JSON.parse(readFileSync(MATCHES, "utf8")));
  const matchProvider = matches.provider;
  console.log(
    `  provenance: extraction_model ${extractionModel} (from ${CONVICTIONS}) · ` +
      `match_provider ${matchProvider} (from ${MATCHES})`,
  );
  if (extractionModel === MODEL_UNRECORDED) {
    console.log(
      `  NOTE: ${CONVICTIONS} predates the _model stamp, so the sheet's extraction_model column ` +
        `reads "${MODEL_UNRECORDED}" for every row. That is the artifact's own answer, not a ` +
        `guess — the next conviction pass records the model it runs on.`,
    );
  }
  const convOf = (id: string): Conviction | null => convictions[id] ?? null;

  // the third register — OPTIONAL (see THE THIRD REGISTER). Absent is a supported bake, and the
  // run says so out loud rather than quietly shipping 312 records with one less register in them.
  const summaries = loadSummaries(SUMMARIES);
  const inferFloor = inferEmitFloor();
  if (!summaries) {
    console.log(
      `  inferred: no ${SUMMARIES} — every record ships without the inferred block ` +
        `(run scripts/enrich-summaries.ts to populate it)`,
    );
  }

  /* ---- 1c. tag overrides replace the extracted tag, and drop its orphaned receipt ---- */
  const overriddenFields = new Map<string, string[]>(); // personId -> the fields a human changed
  let noopOverrides = 0;
  for (const [pid, row] of overrides) {
    if (hiddenIds.has(pid)) continue; // hidden people are not emitted; nothing to override
    const base = convOf(pid);
    const next: Conviction = base
      ? { ...base, quotes: { ...base.quotes } }
      : { motive: null, mission: null, impact: null, aspiration: null, quotes: {}, openSeeker: false };

    const applied: OverridableTag[] = [];
    for (const tag of OVERRIDABLE_TAGS) {
      const want = row[tag];
      if (want === undefined) continue;
      if (next[tag] === want) {
        noopOverrides += 1; // the sheet already said this — not a change, so not a claim
        continue;
      }
      next[tag] = want;
      applied.push(tag);
    }
    if (applied.length === 0) continue;

    // Quotes are NOT overridable. The quote behind a replaced tag is no longer evidence for
    // it, so drop it — unless an UNTOUCHED tag still cites that same answer field, in which
    // case the quote is still somebody's receipt and stays.
    const stillCited = new Set(
      OVERRIDABLE_TAGS.filter((t) => next[t] !== null && !applied.includes(t)).map((t) => TAG_QUOTE_FIELD[t]),
    );
    for (const t of applied) {
      const field = TAG_QUOTE_FIELD[t];
      if (!stillCited.has(field)) delete next.quotes[field];
    }

    convictions[pid] = next;
    overriddenFields.set(pid, applied);
  }

  /* ---- 2. the source: the graph by default, the CSV only as a labelled fallback ---- */
  const fixture = process.env.FIXTURE === "1";
  if (fixture) {
    console.error("┌─────────────────────────────────────────────────────────────────────────┐");
    console.error("│ FIXTURE MODE — Neo4j is NOT traversed. Structural edges are derived from │");
    console.error("│ the CSV groupings (same ring+chord sampling). meta.source records it.    │");
    console.error("└─────────────────────────────────────────────────────────────────────────┘");
  }
  const src = fixture ? readFromFixture(guests, matches.seeks) : await readFromGraph(ids);

  // the source is authoritative for who/what; the CSV must agree or we say so
  const bySrcId = new Map(src.people.map((p) => [p.id, p] as const));
  const drift: string[] = [];
  for (const g of guests) {
    const p = bySrcId.get(g.personId);
    if (!p) continue;
    if (p.name !== g.name) drift.push(`${g.personId}.name "${p.name}" ≠ "${g.name}"`);
    if (p.school !== g.school) drift.push(`${g.personId}.school "${p.school}" ≠ "${g.school}"`);
    if (p.company !== g.company) drift.push(`${g.personId}.company "${p.company}" ≠ "${g.company}"`);
  }
  if (drift.length > 0) {
    console.error(`WARN: ${drift.length} field(s) differ between the source and the CSV — the source wins:`);
    for (const d of drift.slice(0, 8)) console.error(`      ${d}`);
  }

  // people are emitted in CSV order so the layout seed lands the same way every run
  const people: SourcePerson[] = ids.map((id) => bySrcId.get(id)!);

  /* ---- 3. structural edges: ring + chord over the traversed groups ---- */
  const schoolGroups = groupBy(people, "school");
  const companyGroups = groupBy(people, "company");
  if (src.traversedPairs) {
    // grounded counts: what the traversal returned must equal what the groups imply,
    // or the sampling input is not the graph and every downstream count is a guess
    const implied = (m: Map<string, string[]>) =>
      [...m.values()].reduce((acc, arr) => acc + (arr.length * (arr.length - 1)) / 2, 0);
    const impliedSchool = implied(schoolGroups);
    const impliedCompany = implied(companyGroups);
    if (impliedSchool !== src.traversedPairs.school || impliedCompany !== src.traversedPairs.company) {
      throw new EmitError(
        "TraversalMismatch",
        `the graph returned ${src.traversedPairs.school} school / ${src.traversedPairs.company} company pairs, ` +
          `the graph's own groups imply ${impliedSchool} / ${impliedCompany}`,
      );
    }
  }

  const edges: GEdge[] = [];
  const edgeIndex = new Map<string, GEdge[]>();
  const addEdge = (e: GEdge) => {
    edges.push(e);
    for (const id of [e.s, e.t]) {
      const arr = edgeIndex.get(id);
      if (arr) arr.push(e);
      else edgeIndex.set(id, [e]);
    }
  };
  for (const [name, members] of [...schoolGroups].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const [a, b] of sampleGroup(members)) addEdge({ s: a, t: b, type: "school", via: name });
  }
  for (const [name, members] of [...companyGroups].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const [a, b] of sampleGroup(members)) addEdge({ s: a, t: b, type: "company", via: name });
  }

  /* ---- 4. seek edges: whoever is looking for whom, straight from the source ---- */
  const idSet = new Set(ids);
  for (const s of src.seeks) {
    if (!idSet.has(s.from) || !idSet.has(s.to) || s.from === s.to) continue;
    addEdge({ s: s.from, t: s.to, type: "seek", via: s.via, m: s.mutual, score: Number(s.score.toFixed(4)) });
  }
  const mutualPairs = new Set(src.seeks.filter((s) => s.mutual).map((s) => pairKey(s.from, s.to)));

  /* ---- 5. why edges: nearest-2 inside a shared conviction tag ---- */
  const words = new Map<string, Set<string>>();
  for (const g of guests) words.set(g.personId, tokenize(`${g.answers.goal} ${g.answers.drew} ${g.answers.seeking}`));

  const tagGroups = (field: "mission" | "impact" | "motive" | "aspiration") => {
    const m = new Map<string, string[]>();
    for (const id of ids) {
      const tag = convOf(id)?.[field];
      if (!tag) continue;
      const arr = m.get(tag);
      if (arr) arr.push(id);
      else m.set(tag, [id]);
    }
    return m;
  };
  const missionGroups = tagGroups("mission");
  const impactGroups = tagGroups("impact");
  const motiveGroups = tagGroups("motive");
  const aspGroups = tagGroups("aspiration");

  const whySeen = new Set<string>();
  const whyVia = new Map<string, string>();
  /** top-2 partners inside the given tag groups, by how much of their own words they share */
  const linkNearest = (id: string, fields: ("mission" | "impact" | "motive" | "aspiration")[]) => {
    const conv = convOf(id);
    if (!conv) return 0;
    const cands = new Map<string, string>(); // candidate → the tag that connects them
    for (const field of fields) {
      const tag = conv[field];
      if (!tag) continue;
      const groups = field === "mission" ? missionGroups : field === "impact" ? impactGroups : field === "motive" ? motiveGroups : aspGroups;
      for (const other of groups.get(tag) ?? []) if (other !== id && !cands.has(other)) cands.set(other, tag);
    }
    const mine = words.get(id) ?? new Set<string>();
    const ranked = [...cands.entries()]
      .map(([other, tag]) => ({ other, tag, w: overlap(mine, words.get(other) ?? new Set<string>()) }))
      .sort((a, b) => b.w - a.w || a.other.localeCompare(b.other))
      .slice(0, 2);
    let added = 0;
    for (const r of ranked) {
      const k = pairKey(id, r.other);
      if (whySeen.has(k)) continue;
      whySeen.add(k);
      whyVia.set(k, r.tag);
      const [a, b] = id < r.other ? [id, r.other] : [r.other, id];
      addEdge({ s: a, t: b, type: "why", via: pretty(r.tag), score: Number(r.w.toFixed(4)) });
      added += 1;
    }
    return added;
  };
  for (const id of ids) linkNearest(id, ["mission", "impact"]);

  /* ---- 6. the dignity floor, at the graph level: nobody leaves with zero threads ----
   * Whoever ends up with no school-mates, no colleagues, no seeker and no shared
   * mission/impact tag gets a why-edge on the tag they DO have — motive first, then
   * craft. Still a shared conviction tag, still quote-grounded; nothing invented. */
  let rescued = 0;
  for (const id of ids) {
    if ((edgeIndex.get(id)?.length ?? 0) > 0) continue;
    if (linkNearest(id, ["motive"]) === 0) linkNearest(id, ["aspiration"]);
    if ((edgeIndex.get(id)?.length ?? 0) > 0) rescued += 1;
  }
  const stranded = ids.filter((id) => (edgeIndex.get(id)?.length ?? 0) === 0);
  if (stranded.length > 0) {
    throw new EmitError(
      "DignityFloorUnreachable",
      `${stranded.length} guest(s) have no representable connection at all: ${stranded.slice(0, 5).join(", ")}`,
    );
  }

  /* ---- 7. nodes + the three baked layouts ---- */
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.s, (deg.get(e.s) ?? 0) + 1);
    deg.set(e.t, (deg.get(e.t) ?? 0) + 1);
  }
  const nodes: GraphNodeOut[] = people.map((p) => {
    const c = convOf(p.id);
    const g = byGuestId.get(p.id);
    return {
      id: p.id,
      name: p.name,
      title: p.title,
      school: p.school,
      company: p.company,
      free: Boolean(g?.isFreelance), // a CSV-side fact: the ontology has no "freelance" node
      hometown: g?.hometown ?? null, // CSV-side too — the graph has no Place node
      // EMIT-SIDE normalization only. scripts/ingest-guests.ts's place() still names the Neo4j
      // :Place nodes by leading locality and is NOT touched: changing it would force a re-ingest.
      metro: metroOf(g?.hometown)?.name ?? null,
      motive: c?.motive ?? null,
      mission: c?.mission ?? null,
      impact: c?.impact ?? null,
      asp: c?.aspiration ?? null,
      deg: deg.get(p.id) ?? 0,
      pos: { web: [0, 0] as Vec2, why: [0, 0] as Vec2, seek: [0, 0] as Vec2 },
    };
  });

  const web = webLayout(nodes, edges);
  const why = ringLayout(nodes, "motive");
  const seek = ringLayout(nodes, "asp");
  const round = (v: Vec2): Vec2 => [Number(v[0].toFixed(1)), Number(v[1].toFixed(1))];
  for (const n of nodes) {
    n.pos = {
      web: round(web.get(n.id) ?? [0, 0]),
      why: round(why.get(n.id) ?? [0, 0]),
      seek: round(seek.get(n.id) ?? [0, 0]),
    };
  }

  /* ---- 7b. places: the surviving population grouped by metro, coordinates where we have them ----
   * Derived from `nodes`, so a hidden guest is absent from every count for free, and
   * `n === personIds.length` is true by construction rather than by assertion. */
  const placeMembers = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.metro) continue;
    const arr = placeMembers.get(n.metro);
    if (arr) arr.push(n.id);
    else placeMembers.set(n.metro, [n.id]);
  }
  const places: PlaceOut[] = [...placeMembers.entries()]
    .map(([name, members]) => {
      const c = coordOf(name);
      const personIds = [...members].sort();
      // spread the coordinate only when the vendored table HAS one — see PlaceOut
      return { name, ...(c ? { lat: c.lat, lng: c.lng } : {}), n: personIds.length, personIds };
    })
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const placesCoordinated = places.filter((p) => p.lat !== undefined).length;
  const placeablePeople = places.reduce((acc, p) => acc + (p.lat !== undefined ? p.n : 0), 0);

  /* ---- 7c. taste twins: exact-match on two answers nothing has ever read ----
   * Computed over the SURVIVING guests, so a hidden guest is nobody's twin. */
  const taste = tasteMatches(guests.map((g) => ({ personId: g.personId, answers: g.answers })));

  /* ---- 8. person records: ranked connections with receipts, then highlights ---- */
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const inbound = new Map<string, SeekRow[]>();
  const outbound = new Map<string, SeekRow[]>();
  for (const s of src.seeks) {
    if (!idSet.has(s.from) || !idSet.has(s.to) || s.from === s.to) continue;
    (inbound.get(s.to) ?? inbound.set(s.to, []).get(s.to)!).push(s);
    (outbound.get(s.from) ?? outbound.set(s.from, []).get(s.from)!).push(s);
  }
  const doppelOf = new Map<string, { other: string; score: number }>();
  for (const d of matches.doppels) {
    if (!idSet.has(d.a) || !idSet.has(d.b)) continue;
    for (const [x, y] of [[d.a, d.b], [d.b, d.a]] as const) {
      const cur = doppelOf.get(x);
      if (!cur || d.score > cur.score) doppelOf.set(x, { other: y, score: d.score });
    }
  }

  const answersOf = (id: string) => byGuestId.get(id)?.answers;
  /** the strongest thing they said about what they do — title first, then their own goal */
  const craftLine = (id: string): Receipt | undefined => {
    const g = byGuestId.get(id);
    if (!g) return undefined;
    const parts = [g.title, clip(g.answers.goal, 180)].filter((s) => s.length > 0);
    return parts.length > 0 ? { field: "title", quote: parts.join(" — ") } : undefined;
  };
  const seekingLine = (id: string): Receipt | undefined => {
    const a = answersOf(id);
    return a && a.seeking.length > 0 ? { field: "seeking", quote: clip(a.seeking) } : undefined;
  };
  /** the verbatim quote the conviction extraction stood on — goal first, then drew */
  const convictionQuote = (id: string): Receipt | undefined => {
    const q = convOf(id)?.quotes ?? {};
    for (const field of ["goal", "drew", "seeking", "inspiration"]) {
      const quote = q[field];
      if (quote) return { field, quote };
    }
    return undefined;
  };
  /**
   * Fallback why-receipt for a side with no surviving extraction quote — an
   * overridden tag's quote is dropped by the override law, and a why-edge whose
   * sides BOTH lost their quote would ship unprovable (audit I2). The fallback
   * is a verbatim PREFIX of the answer field the shared tag is read from
   * (motive ← drew, everything else ← goal): the same "the field is the
   * receipt" convention the route's fieldFallback renders for school/company.
   * clip() never adds an ellipsis, so this stays a byte-literal span (audit I1).
   * Nothing is invented; when both fields are blank the side stays quoteless.
   */
  const tagFieldLine = (id: string, tag: string): Receipt | undefined => {
    const a = answersOf(id);
    if (!a) return undefined;
    const primary = (MOTIVES as readonly string[]).includes(tag) ? "drew" : "goal";
    for (const field of [primary, primary === "drew" ? "goal" : "drew"] as const) {
      if (a[field].trim() !== "") return { field, quote: clip(a[field], 180) };
    }
    return undefined;
  };
  const cellReceipt = (id: string, col: "school" | "company"): Receipt | undefined => {
    const g = byGuestId.get(id);
    if (!g) return undefined;
    const cell = rawCell(g, col);
    return cell ? { field: col, quote: cell } : undefined;
  };
  const withReceipt = (yours?: Receipt, theirs?: Receipt) =>
    yours || theirs ? { receipt: { ...(yours ? { yours } : {}), ...(theirs ? { theirs } : {}) } } : {};

  const WEIGHT: Record<string, number> = { mutual: 100, inbound: 90, outbound: 80, why: 60, company: 40, school: 30 };
  const INBOUND_CAP = 8;
  const OTHER_CAP = 12;

  let records = 0;
  let convictionBlocks = 0;
  let convictionReceipts = 0;
  // the third register's tally — every one of these is reported, including the drops
  let inferredBlocks = 0;
  let inferredMissions = 0;
  let inferredImpacts = 0;
  let inferredSpans = 0;
  let inferredBelowFloor = 0;
  let inferredNoRecord = 0;
  let inferredNothingToSay = 0;
  // the fourth block's tally
  let tasteBlocks = 0;
  let tasteTwinQuotes = 0;
  const tasteFieldCounts: Record<string, number> = { favorite: 0, inspiration: 0 };
  const highlightHist = new Map<string, number>();
  const edgeCounts: number[] = [];
  const pinMisses: string[] = [];
  const sheetRows: Record<string, string>[] = [];

  if (existsSync(PEOPLE_DIR)) rmSync(PEOPLE_DIR, { recursive: true });
  mkdirSync(PEOPLE_DIR, { recursive: true });

  for (const me of nodes) {
    const g = byGuestId.get(me.id);
    if (!g) throw new EmitError("GuestMissing", `no CSV guest behind node ${me.id}`);
    const c = convOf(me.id);

    /* ---- connections ---- */
    const scored: { e: PersonEdge; w: number; strength: number }[] = [];
    const seekSeen = new Set<string>();
    const pushSeek = (other: string, row: SeekRow, dir: Direction) => {
      if (seekSeen.has(other)) return;
      seekSeen.add(other);
      const yours = dir === "inbound" ? craftLine(me.id) : (seekingLine(me.id) ?? craftLine(me.id));
      const theirs = dir === "inbound" ? seekingLine(other) : dir === "mutual" ? (seekingLine(other) ?? craftLine(other)) : craftLine(other);
      scored.push({
        e: {
          targetId: other,
          type: "seek",
          direction: dir,
          strength: Number(row.score.toFixed(4)),
          via: row.via,
          ...withReceipt(yours, theirs),
        },
        w: WEIGHT[dir],
        strength: row.score,
      });
    };
    const mine = { in: inbound.get(me.id) ?? [], out: outbound.get(me.id) ?? [] };
    const mutualRows = [...mine.in, ...mine.out].filter((s) => mutualPairs.has(pairKey(s.from, s.to)));
    for (const s of mutualRows.sort((a, b) => b.score - a.score)) pushSeek(s.from === me.id ? s.to : s.from, s, "mutual");
    for (const s of [...mine.in].sort((a, b) => b.score - a.score)) pushSeek(s.from, s, "inbound");
    for (const s of [...mine.out].sort((a, b) => b.score - a.score)) pushSeek(s.to, s, "outbound");

    for (const e of edgeIndex.get(me.id) ?? []) {
      if (e.type === "seek") continue;
      const other = e.s === me.id ? e.t : e.s;
      if (e.type === "why") {
        const tag = whyVia.get(pairKey(me.id, other)) ?? e.via;
        scored.push({
          e: {
            targetId: other,
            type: "why",
            via: pretty(tag),
            strength: e.score,
            ...withReceipt(
              convictionQuote(me.id) ?? tagFieldLine(me.id, tag),
              convictionQuote(other) ?? tagFieldLine(other, tag),
            ),
          },
          w: WEIGHT.why,
          strength: e.score ?? 0,
        });
      } else {
        scored.push({
          e: {
            targetId: other,
            type: e.type,
            via: e.via,
            ...withReceipt(cellReceipt(me.id, e.type), cellReceipt(other, e.type)),
          },
          w: WEIGHT[e.type],
          strength: 0,
        });
      }
    }
    scored.sort((a, b) => b.w - a.w || b.strength - a.strength || a.e.targetId.localeCompare(b.e.targetId));
    const towardMe = scored.filter((s) => s.e.direction === "mutual" || s.e.direction === "inbound").slice(0, INBOUND_CAP);
    const rest = scored.filter((s) => !(s.e.direction === "mutual" || s.e.direction === "inbound")).slice(0, OTHER_CAP);
    const personEdges = [...towardMe, ...rest].map((s) => s.e);

    /* ---- the pin: reorder an EXISTING edge, never mint one ---- */
    const stamped = [...(overriddenFields.get(me.id) ?? [])];
    const pin = overrides.get(me.id)?.pinned_match;
    if (pin) {
      const at = personEdges.findIndex((e) => e.targetId === pin);
      if (at < 0) {
        pinMisses.push(
          `${me.id} → ${pin}${byGuestId.has(pin) ? "" : " (not in the emitted population)"}`,
        );
      } else if (at > 0) {
        personEdges.unshift(...personEdges.splice(at, 1));
        stamped.push("pinned_match");
      } else {
        stamped.push("pinned_match"); // already rank 1 — the pin still governs the order
      }
    }

    /* ---- highlights: every one of them positive-or-neutral, none of them zero ---- */
    const hl: Highlight[] = [];
    const inN = mine.in.length;
    if (inN > 0) {
      const top = [...mine.in].sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.from);
      const tail = inN > INBOUND_CAP ? ` The closest ${INBOUND_CAP} are listed above.` : "";
      hl.push({
        kind: "sought-by",
        text: `${inN} ${inN === 1 ? "person is" : "people are"} looking for someone like you tonight.${tail}`,
        targets: top,
      });
    }
    const mutualIds = [...new Set(mutualRows.map((s) => (s.from === me.id ? s.to : s.from)))];
    if (mutualIds.length > 0) {
      hl.push({
        kind: "mutual",
        text:
          mutualIds.length === 1
            ? "You are looking for each other:"
            : `${mutualIds.length} people here are looking for you as much as you are for them:`,
        targets: mutualIds.slice(0, 3),
      });
    }
    const dop = doppelOf.get(me.id);
    if (dop && nodeById.has(dop.other)) {
      hl.push({ kind: "doppelganger", text: "The answers closest to yours in the room tonight:", targets: [dop.other] });
    }
    const schoolN = me.school ? schoolGroups.get(me.school)?.length ?? 0 : 0;
    if (me.school && schoolN > 1) hl.push({ kind: "one-of-n", text: `One of ${schoolN} from ${me.school} in the room.` });
    const companyN = me.company ? companyGroups.get(me.company)?.length ?? 0 : 0;
    if (me.company && companyN > 1) hl.push({ kind: "one-of-n", text: `One of ${companyN} at ${me.company} tonight.` });
    const missionN = c?.mission ? missionGroups.get(c.mission)?.length ?? 0 : 0;
    if (c?.mission && missionN >= 3) {
      hl.push({ kind: "conviction-caucus", text: `One of ${missionN} here to ${phraseOf(MISSION_PHRASE, c.mission, "mission")}.` });
    } else if (c?.impact) {
      const impactN = impactGroups.get(c.impact)?.length ?? 0;
      if (impactN >= 3) {
        hl.push({ kind: "conviction-caucus", text: `One of ${impactN} who want the work to ${phraseOf(IMPACT_PHRASE, c.impact, "impact")}.` });
      }
    }
    if (c?.motive) {
      const motiveN = motiveGroups.get(c.motive)?.length ?? 0;
      if (motiveN >= 2) {
        hl.push({ kind: "motive", text: `One of ${motiveN} who came to this through ${phraseOf(MOTIVE_PHRASE, c.motive, "motive")}.` });
      }
    }
    if (c?.aspiration) {
      const aspN = aspGroups.get(c.aspiration)?.length ?? 0;
      if (aspN >= 2) {
        const phrase = phraseOf(ASP_PHRASE, c.aspiration, "aspiration");
        hl.push({
          kind: "craft",
          text:
            c.aspiration === "undecided"
              ? `One of ${aspN} still working out where they land.`
              : `One of ${aspN} aiming to ${phrase}.`,
        });
      }
    }
    if (g.hometown) hl.push({ kind: "hometown", text: `Came from ${g.hometown}.` });
    if (c?.openSeeker) hl.push({ kind: "open", text: "Said they are open to meeting anyone here." });
    hl.push({ kind: "room", text: `One of ${nodes.length} people in the room tonight.` });

    const highlights = hl.slice(0, 6);
    if (highlights.length < 3 || personEdges.length < 1) {
      throw new EmitError(
        "DignityFloorBreached",
        `${me.id} would ship with ${personEdges.length} edge(s) and ${highlights.length} highlight(s)`,
      );
    }
    for (const h of highlights) highlightHist.set(h.kind, (highlightHist.get(h.kind) ?? 0) + 1);
    edgeCounts.push(personEdges.length);

    /* ---- the one receipt law, read by BOTH the record's conviction block and the sheet row:
       a tag's quote survives only if a human did not move that tag. Defined once here so the
       drop cannot be honoured in one artifact and forgotten in the other. ---- */
    const quoteFor = (tag: OverridableTag): string => {
      if (!c || c[tag] === null) return "";
      // an overridden tag's receipt was dropped with the tag — never re-attach it here
      if (overriddenFields.get(me.id)?.includes(tag)) return "";
      return c.quotes[TAG_QUOTE_FIELD[tag]] ?? "";
    };

    /* ---- the conviction block: the computed identity, post-override, with its receipts ---- */
    const conviction: ConvictionOut = {};
    for (const t of OVERRIDABLE_TAGS) {
      const tag = c?.[t];
      if (tag) conviction[t] = tag;
    }
    const convQuotes: Record<string, string> = {};
    for (const t of QUOTED_TAGS) {
      const q = quoteFor(t);
      if (q) convQuotes[t] = q;
    }
    if (Object.keys(convQuotes).length > 0) conviction.quotes = convQuotes;
    if (Object.keys(conviction).length > 0) convictionBlocks += 1;
    convictionReceipts += Object.keys(convQuotes).length;

    /* ---- the inferred block: OUR read and OUR labels, a SIBLING of the conviction above and
       never a key inside it (THE THIRD REGISTER). Every span is re-verified against this
       guest's own answers here — the artifact is a separate file and may be stale. ---- */
    let inferred: InferredOut | undefined;
    if (summaries) {
      const sum = summaries.records[me.id];
      if (!sum) {
        // the artifact does not cover this guest: an older run, or a filtered one. Not fatal —
        // they simply ship without the register — but counted and reported, never invisible.
        inferredNoRecord += 1;
      } else {
        const verify = (where: string, evidence: readonly InferredEvidenceOut[]): InferredEvidenceOut[] => {
          for (const ev of evidence) {
            const source = g.answers[ev.field as keyof typeof g.answers] ?? "";
            // EXACT: byte-literal containment, ZERO normalization — the same test the gate and
            // the receipts audit apply. A span that does not resolve is a fabricated receipt.
            if (!source.includes(ev.quote)) {
              throw new EmitError(
                "InferredSpanUnverifiable",
                `${me.id} ${where} cites a span that is not in their own "${ev.field}" answer — ` +
                  `${SUMMARIES} is stale against ${csvPath}; re-run scripts/enrich-summaries.ts`,
              );
            }
          }
          return evidence.map((ev) => ({ field: ev.field, quote: ev.quote }));
        };

        const built: Omit<InferredOut, "_src" | "_model"> = {};
        if (sum.summary) {
          // law c: a read with no receipt is not shippable, whatever its confidence
          if (sum.summary.evidence.length === 0) {
            throw new EmitError("InferredEvidenceMissing", `${me.id} summary carries no evidence span`);
          }
          built.summary = {
            text: sum.summary.text,
            confidence: sum.summary.confidence,
            evidence: verify("summary", sum.summary.evidence),
          };
        }
        // THE RENDER FLOOR — a label below it is dropped and COUNTED, never quietly shipped.
        // `summary` is deliberately not floored: its confidence is informative, not gating.
        for (const key of ["mission", "impact"] as const) {
          const claim = sum.inferred[key];
          if (!claim) continue;
          if (claim.confidence < inferFloor) {
            inferredBelowFloor += 1;
            continue;
          }
          if (claim.evidence.length === 0) {
            throw new EmitError("InferredEvidenceMissing", `${me.id} inferred ${key} "${claim.value}" carries no evidence span`);
          }
          built[key] = {
            value: claim.value,
            confidence: claim.confidence,
            evidence: verify(`inferred.${key}`, claim.evidence),
          };
        }

        if (Object.keys(built).length === 0) {
          // a guard-failed or blank-answer guest: nothing to say is a legitimate outcome, and an
          // empty block would be a claim of its own. Omit it, count it, move on.
          inferredNothingToSay += 1;
        } else {
          inferred = {
            ...built,
            // ECHOED from the artifact, never re-derived from the environment (law d)
            _src: summaries._src,
            _model: summaries._model,
          };
          inferredBlocks += 1;
          if (built.mission) inferredMissions += 1;
          if (built.impact) inferredImpacts += 1;
          inferredSpans +=
            (built.summary?.evidence.length ?? 0) +
            (built.mission?.evidence.length ?? 0) +
            (built.impact?.evidence.length ?? 0);
        }
      }
    }

    /* ---- the taste block: THE FOURTH BLOCK. Every quote on both sides is re-verified against
       the cited person's own answer before it is written — the same rule the inferred spans
       get, for the same reason: a receipt that does not resolve is a fabricated receipt. ---- */
    const mineTaste = taste.matches.get(me.id);
    let tasteOut: Partial<Record<string, TasteMatch>> | undefined;
    if (mineTaste) {
      for (const field of TASTE_FIELDS) {
        const hit = mineTaste[field];
        if (!hit) continue;
        if (!g.answers[field].includes(hit.verbatim)) {
          throw new EmitError("TasteQuoteUnverifiable", `${me.id} taste.${field} is not their own "${field}" answer`);
        }
        for (const w of hit.with) {
          const theirs = byGuestId.get(w.personId)?.answers[field] ?? "";
          if (!theirs.includes(w.quote)) {
            throw new EmitError(
              "TasteQuoteUnverifiable",
              `${me.id} taste.${field} cites ${w.personId}, whose own "${field}" answer does not contain the quoted cell`,
            );
          }
          tasteTwinQuotes += 1;
        }
        tasteFieldCounts[field] += 1;
      }
      tasteOut = mineTaste;
      tasteBlocks += 1;
    }

    writeFileSync(
      join(PEOPLE_DIR, `${me.id}.json`),
      `${JSON.stringify({
        personId: me.id,
        name: me.name,
        answers: g.answers,
        edges: personEdges,
        highlights,
        // omitted entirely for anyone the extraction had nothing to say about
        ...(Object.keys(conviction).length > 0 ? { conviction } : {}),
        // register 2+3, a SIBLING of `conviction` — never nested inside it (THE THIRD REGISTER)
        ...(inferred ? { inferred } : {}),
        // a sibling again, never an edge and never a highlight (THE FOURTH BLOCK)
        ...(tasteOut ? { taste: tasteOut } : {}),
        // honest provenance (law d): the artifact itself says which fields a human moved
        ...(stamped.length > 0 ? { _overridden: stamped } : {}),
      })}\n`,
    );
    if (stamped.length > 0) me._overridden = stamped;
    records += 1;

    /* ---- the enrichment sheet row: everything this bake decided, on one line ---- */
    const ov = overrides.get(me.id);
    const groups: string[] = [];
    if (c?.mission) {
      const n = missionGroups.get(c.mission)?.length ?? 0;
      if (n >= 3) groups.push(`${c.mission}(${n})`);
    }
    if (c?.impact) {
      const n = impactGroups.get(c.impact)?.length ?? 0;
      if (n >= 3) groups.push(`${c.impact}(${n})`);
    }
    const dopp = doppelOf.get(me.id);
    const row: Record<string, string> = {
      person_id: me.id,
      guest_id: g.guestId,
      name: me.name,
      title: me.title,
      company: rawCell(g, "company"),
      is_freelance: String(g.isFreelance),
      school: rawCell(g, "school"),
      class_year: classYearOf(rawCell(g, "school")),
      hometown: g.hometown ?? "",
      // the derived metro beside the cell it came from, so a host can SEE a bad merge on the
      // same line as the words that caused it (the sheet's job — the enrichment loop above)
      metro: me.metro ?? "",
      instagram: g.instagram ?? "",
      motive: c?.motive ?? "",
      mission: c?.mission ?? "",
      impact: c?.impact ?? "",
      aspiration: c?.aspiration ?? "",
      open_seeker: String(Boolean(c?.openSeeker)),
      motive_quote: quoteFor("motive"),
      mission_quote: quoteFor("mission"),
      impact_quote: quoteFor("impact"),
      school_node: me.school ?? "",
      company_node: me.company ?? "",
      craft_node: c?.aspiration ? phraseOf(ASP_PHRASE, c.aspiration, "aspiration") : "",
      conviction_groups: groups.join("; "),
      inbound_count: String(mine.in.length),
      mutual_with: mutualIds.join("; "),
      doppelganger: dopp?.other ?? "",
      doppelganger_score: dopp ? String(Number(dopp.score.toFixed(4))) : "",
      pinned_match: ov?.pinned_match ?? "",
      // `hide` is a one-way door: a hidden guest has no row at all, so this column is the
      // echo of an override that could only ever read false here.
      hide: ov?.hide === true ? "true" : "",
      host_notes: ov?.host_notes ?? "",
      flags: [...g.flags, ...(c?.flags ?? [])].join("; "),
      extraction_model: extractionModel,
      match_provider: matchProvider,
    };
    for (let i = 0; i < 5; i++) {
      const e = personEdges[i];
      row[`match_${i + 1}`] = e ? `${e.targetId}|${e.strength ?? ""}|${e.via}` : "";
    }
    sheetRows.push(row);
  }

  /* ---- 8b. write the sheet ---- */
  writeFileSync(
    ENRICHED_SHEET,
    `${Papa.unparse(sheetRows, { columns: [...SHEET_COLUMNS], newline: "\n" })}\n`,
    "utf8",
  );

  /* ---- 9. graph.json ---- */
  const counts: Record<string, number> = {};
  for (const e of edges) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const graph = {
    nodes,
    edges,
    // top-level, beside nodes and edges: `places` is a grouping OF the nodes, not metadata
    // about the bake (THE FOURTH BLOCK). Every personIds member is an emitted node.
    places,
    meta: {
      people: nodes.length,
      built: new Date().toISOString(),
      source: src.label,
      // which vector provider produced the SEEKS matches this bake reads — mirrors the
      // SEEKS rels' `_src="match:<provider>-v1"` (law d) so the artifact is self-describing
      // without a DB round trip. ECHOED from matches.json's own `_provider`, which the matching
      // run stamped on itself; this leg never asks EMBED_PROVIDER what it would do today.
      matchProvider,
      /**
       * Where the coordinates in `places` came from (law d). They are WORLD KNOWLEDGE — a city
       * is at the same latitude whoever came to the party — so they are the one thing in this
       * artifact that is not derived from a guest, and the artifact says so out loud. `metros`
       * counts every place we can name, `coordinated` only the ones we can draw; the gap IS
       * the honest absence, and it is a number rather than a silence.
       */
      placeCoords: {
        _src: PLACE_COORDS_SRC,
        metros: places.length,
        coordinated: placesCoordinated,
        placeable: placeablePeople,
      },
      counts,
      stages: {
        rows: rowCount,
        approved: approvedCount,
        unique: nodes.length,
        schools: new Set(people.map((p) => p.school).filter(Boolean)).size,
        companies: new Set(people.map((p) => p.company).filter(Boolean)).size,
        // grounded: people whose conviction stands on at least one verbatim quote
        convictions: ids.filter((id) => Object.keys(convOf(id)?.quotes ?? {}).length > 0).length,
        seekEdges: counts.seek ?? 0,
        mutuals: mutualPairs.size,
        whyEdges: counts.why ?? 0,
      },
      // the Luma guest_ids — opaque, non-PII, and the only thing the drop-zone checks a
      // dragged CSV against (it never uploads the file)
      guestIds: guests.map((g) => g.guestId),
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const body = `${JSON.stringify(graph)}\n`;
  writeFileSync(join(OUT_DIR, "graph.json"), body);

  /* ---- 10. say what happened ---- */
  const avg = edgeCounts.reduce((a, b) => a + b, 0) / Math.max(edgeCounts.length, 1);
  console.log(`emit-graph [source: ${src.label}] → ${OUT_DIR}`);
  console.log(
    `  nodes ${nodes.length} · edges ${edges.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}) · graph.json ${(body.length / 1024).toFixed(0)}KB`,
  );
  console.log(
    `  person records ${records} · edges/record min ${Math.min(...edgeCounts)} avg ${avg.toFixed(1)} max ${Math.max(...edgeCounts)}`,
  );
  console.log(`  highlights: ${[...highlightHist].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  console.log(
    `  conviction blocks ${convictionBlocks}/${records} · ${convictionReceipts} verbatim receipt(s) ` +
      `(a tag a human moved ships without one)`,
  );
  if (summaries) {
    console.log(
      `  inferred blocks ${inferredBlocks}/${records} [${summaries._src} · ${summaries._model}] · ` +
        `${inferredMissions} mission(s) · ${inferredImpacts} impact(s) at the ${inferFloor} floor` +
        `${process.env.INFER_EMIT_FLOOR?.trim() ? " (INFER_EMIT_FLOOR override)" : ""} · ` +
        `${inferredSpans} verified span(s)`,
    );
    // the drops are part of the report: a floor nobody can see is a floor nobody can argue with
    if (inferredBelowFloor > 0) console.log(`    ${inferredBelowFloor} label(s) held back below the ${inferFloor} floor`);
    if (inferredNothingToSay > 0) console.log(`    ${inferredNothingToSay} guest(s) with no read to ship (blank answers or a guard failure)`);
    if (inferredNoRecord > 0) {
      console.error(`WARN: ${inferredNoRecord} emitted guest(s) have no record in ${SUMMARIES} — it is stale or was written by a filtered run`);
    }
  }
  // the places report names BOTH halves: what we can draw, and what we can only count
  const rawHometowns = new Set(guests.map((g) => g.hometown ?? "").filter((h) => h !== "")).size;
  console.log(
    `  places ${places.length} metro(s) from ${rawHometowns} distinct hometown cell(s) [${PLACE_COORDS_SRC}] · ` +
      `${placesCoordinated} with coordinates (${placeablePeople} people placeable) · ` +
      `${places.length - placesCoordinated} counted but not drawable`,
  );
  console.log(
    `    largest: ${places.slice(0, 5).map((p) => `${p.name} ${p.n}`).join(" · ")}`,
  );
  // the fourth block, including what it REFUSED to match — see lib/taste.ts PLACEHOLDER
  console.log(
    `  taste ${tasteBlocks}/${records} record(s) carry a twin [` +
      `${TASTE_FIELDS.map((f) => `${f} ${tasteFieldCounts[f]} in ${taste.stats[f].clusters} cluster(s), biggest ${taste.stats[f].biggest}`).join(" · ")}] · ` +
      `${tasteTwinQuotes} twin-side quote(s), every one byte-verbatim in that twin's own answer`,
  );
  for (const f of TASTE_FIELDS) {
    const s = taste.stats[f];
    if (s.placeheld > 0) {
      console.log(
        `    ${s.placeheld} ${f} answer(s) held back as placeholders — "my mom" is seven different women, ` +
          `and an equal string there is not a shared anything (lib/taste.ts PLACEHOLDER)`,
      );
    }
  }
  console.log(`  enrichment sheet → ${ENRICHED_SHEET} (${sheetRows.length} rows × ${SHEET_COLUMNS.length} columns)`);

  /* the override summary — an override that nobody can see is an override nobody can undo */
  if (overrides.size === 0) {
    console.log(`  overrides: none (${existsSync(OVERRIDES_PATH) ? `${OVERRIDES_PATH} is header-only` : `no ${OVERRIDES_PATH}`})`);
  } else {
    const tagCount = [...overriddenFields.values()].reduce((a, b) => a + b.length, 0);
    const pinned = ids.filter((id) => overrides.get(id)?.pinned_match).length;
    console.log(
      `  overrides [${OVERRIDES_PATH}]: ${overrides.size} row(s) → ${tagCount} tag replacement(s) on ` +
        `${overriddenFields.size} person(s) · ${hiddenIds.size} hidden · ${pinned} pinned match(es)` +
        (noopOverrides > 0 ? ` · ${noopOverrides} already agreed with the extraction (no-op)` : ""),
    );
    for (const [pid, fields] of overriddenFields) console.log(`    ${pid}: ${fields.join(", ")}`);
    if (hiddenIds.size > 0) {
      console.log(`    hidden (absent from every artifact): ${[...hiddenIds].join(", ")}`);
      console.error(
        `WARN: the emitted population is ${nodes.length}, not ${allGuests.length} — scripts/check-graph-emit.ts ` +
          `(EXPECTED_PEOPLE) and scripts/audit-graph.ts (CSV-derived population) will report the difference ` +
          `until the hidden guests are declared there too. That is the population gate working, not a bug.`,
      );
    }
  }
  if (pinMisses.length > 0) {
    console.error(`WARN: ${pinMisses.length} pinned_match target(s) have no existing edge — NOT fabricated, order unchanged:`);
    for (const m of pinMisses) console.error(`      ${m}`);
  }
  if (rescued > 0) console.log(`  dignity floor: ${rescued} guest(s) linked on their motive/craft tag (no other thread existed)`);
  if (unknownTags.size > 0) console.error(`WARN: tags outside the phrase vocabulary, rendered as-is — ${[...unknownTags].join(", ")}`);
  if (src.traversedPairs) {
    console.log(
      `  traversal: ${src.traversedPairs.school} school pairs + ${src.traversedPairs.company} company pairs read from Neo4j, sampled to ${(counts.school ?? 0) + (counts.company ?? 0)}`,
    );
  }
  return 0;
}

main()
  .then(async (code) => {
    await close().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    await close().catch(() => undefined);
    const e = err as Error;
    console.error(e?.name === "Neo4jNotConfigured" ? `DEGRADED — ${e.message}` : (e?.message ?? String(err)));
    console.error("       (offline? re-run with FIXTURE=1 to bake from the CSV instead — the artifact will say so)");
    process.exit(2);
  });
