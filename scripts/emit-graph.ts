/**
 * scripts/emit-graph.ts — bake the party into the two artifacts the /graph room serves:
 *
 *   public/graph/graph.json          nodes + edges + per-lens positions + meta
 *   public/graph/people/<id>.json    one record per guest: their own words, their ranked
 *                                    connections with receipts, their highlights, and the
 *                                    display half of their passport (joined from
 *                                    data/passports/<id>.json — see THE PASSPORT JOIN below)
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
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { z } from "zod";
import { loadGuests, type Guest } from "../lib/guests";
import { passportSchema } from "../passport/schema";
import { isConfigured, run, toNum, close, Neo4jNotConfigured } from "../lib/neo4j";
import { webLayout, ringLayout, type Vec2 } from "../lib/layout";
import { vectorProvider } from "../lib/matches";
import { MOTIVES, MISSIONS, IMPACTS, ASPIRATIONS, convictionModel } from "../lib/conviction";

/* ────────────────────────────── inputs + shapes ────────────────────────────── */

const OUT_DIR = "public/graph";
const PEOPLE_DIR = join(OUT_DIR, "people");
const CONVICTIONS = "data/graph-private/convictions.json";
const MATCHES = "data/graph-private/matches.json";

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

/* ═════════════════════════════ THE PASSPORT JOIN ═════════════════════════════
 *
 * `scripts/generate-passports.ts` writes one `data/passports/<personId>.json` per guest —
 * the agent's traversal of the graph, validated by `passport/schema.ts`. The scene reads
 * `public/graph/people/<personId>.json`. Both are keyed by the SAME personId, so the display
 * half of the passport is joined onto the person record here and the room needs exactly one
 * fetch to render a selected person's finds, hidden prompt, magic inference and gradient.
 *
 * WHAT IS JOINED — display fields only:
 *   find[]           { personId, name, why, via?, basis_kind?, path_receipt }
 *   hidden_prompt    the scavenger line (about someone ELSE, never the holder)
 *   magic_inference  the interpretive read of the holder's own text
 *   gradient         { stops }
 *
 * THREE DECISIONS, all of them departures worth naming:
 *
 *  1. `path_receipt` IS KEPT, on every find. The brief allowed dropping it where the record's
 *     own `edges` already carry a receipt for that person — but measured against the shipped
 *     artifacts, only 177 of 623 finds (28.4%) have such an edge: the passport's finds come
 *     from DOES / SHARES_VALUE traversals, the record's edges from school / company / why /
 *     seek, and the two overlap only by accident. A conditional drop would therefore leave
 *     ~72% of rendered why-lines with no proof anywhere in the record AND give the renderer a
 *     non-uniform shape. Law (c) says a `why` with no edge behind it is a bug, so the
 *     passport's own audited path travels with it — the same array `scripts/audit-receipts.ts`
 *     re-resolves against Neo4j. Cost: ~235B of the ~1.1KB this join adds per record.
 *
 *  2. `gradient.seed` IS DROPPED; only `stops` are joined. The seed is `fnv1a(personId)`
 *     (lib/passport.ts) — recomputable from the record's own personId, and never read by any
 *     renderer (the three stop hues are hashed from school / cluster / activity, not from it).
 *     Its 9–10 digit decimal run is PHONE-SHAPED: it trips the contact-PII tripwire in
 *     `scripts/check-graph-emit.ts` in 236 of 312 records. The tripwire is right and the field
 *     is worthless here, so the field goes. Weakening a PII gate to admit a decorative number
 *     is the trade we never make.
 *
 *  3. `line2`, `profile` and `match_belief` are NOT joined. They are either already on the
 *     record/node (school, company, title) or outside the brief's field list; `profile` in
 *     particular carries school text, and the record has no need of a second copy.
 *
 * A find whose target is not in the emitted population is DROPPED with a named warning (the
 * same law `hide` already obeys: a hidden guest leaves every artifact, including other
 * people's match lists) — never rewritten to point at somebody else.
 *
 * A missing passport file → `passport: null` on that record plus a loud per-person warning.
 * Above PASSPORT_MISSING_MAX of the population the run FAILS: a handful of gaps is a sparse
 * dir, 5%+ is a STALE one, and a stale passports dir silently under-renders the whole room.
 * A passport that is present but off-schema is never "missing" — it is a named error (law b).
 * ════════════════════════════════════════════════════════════════════════════ */

const PASSPORTS_DIR = "data/passports";
/** share of the population allowed to ship without a passport before the dir is called stale */
const PASSPORT_MISSING_MAX = 0.05;

/** The pinned column order of data/graph-enriched.csv. check-graph-emit.ts asserts it exactly. */
const SHEET_COLUMNS = [
  "person_id", "guest_id", "name", "title", "company", "is_freelance", "school", "class_year",
  "hometown", "instagram",
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
const ConvictionsSchema = z.record(z.string(), ConvictionSchema);
const MatchesSchema = z.object({
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
type Conviction = z.infer<typeof ConvictionSchema>;
type SeekRow = z.infer<typeof MatchesSchema>["seeks"][number];

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
/** one directed edge of the real graph path a find stands on — verbatim from the passport */
interface PathEdge {
  from: string;
  rel: string;
  to: string;
}
/** the display half of a passport, joined onto the person record (see THE PASSPORT JOIN) */
interface RecordPassport {
  find: {
    personId: string;
    name: string;
    why: string;
    via?: string;
    basis_kind?: string;
    path_receipt: PathEdge[];
  }[];
  hidden_prompt: string;
  magic_inference: string;
  gradient: { stops: { color: string; at: number }[] };
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
      byte-for-byte against the CSV like every other node field. */
  hometown: string | null;
  motive: string | null;
  mission: string | null;
  impact: string | null;
  asp: string | null;
  deg: number;
  pos: { web: Vec2; why: Vec2; seek: Vec2 };
  _overridden?: string[];
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

/* ─────────────────────────── the passport join ─────────────────────────── */

/**
 * Read every emitted person's passport and project it down to the display fields.
 *
 * `passport/schema.ts` (a declared shared surface) is the boundary: a passport that does not
 * satisfy it is a NAMED error, not a skipped file — an off-schema passport that quietly
 * became a `null` would look exactly like an ungenerated one, and the 5% staleness gate would
 * then be measuring the wrong thing. Absent files are the only tolerated gap, and they are
 * returned so the caller can warn per person and decide.
 */
function loadPassports(ids: readonly string[]): {
  joined: Map<string, RecordPassport>;
  missing: string[];
  droppedFinds: string[];
} {
  const joined = new Map<string, RecordPassport>();
  const missing: string[] = [];
  const droppedFinds: string[] = [];
  const inPopulation = new Set(ids);

  for (const id of ids) {
    const path = join(PASSPORTS_DIR, `${id}.json`);
    if (!existsSync(path)) {
      missing.push(id);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new EmitError("PassportUnparseable", `${path} is not valid JSON: ${(e as Error).message}`);
    }
    const res = passportSchema.safeParse(raw);
    if (!res.success) {
      const issues = res.error.issues
        .slice(0, 3)
        .map((is) => `${is.path.join(".") || "<root>"}: ${is.message}`)
        .join(" | ");
      throw new EmitError("PassportInvalid", `${path} does not satisfy passport/schema.ts — ${issues}`);
    }
    const p = res.data;
    if (p.personId !== id) {
      throw new EmitError(
        "PassportSubjectMismatch",
        `${path} carries personId "${p.personId}" — a passport joined onto the wrong person is a fabricated claim`,
      );
    }

    const find = p.find
      .filter((f) => {
        if (inPopulation.has(f.personId)) return true;
        droppedFinds.push(`${id} → ${f.personId}`);
        return false;
      })
      .map((f) => ({
        personId: f.personId,
        name: f.name,
        why: f.why,
        ...(f.via ? { via: f.via } : {}),
        ...(f.basis_kind ? { basis_kind: f.basis_kind } : {}),
        // the receipt travels with the claim — see decision 1 in THE PASSPORT JOIN
        path_receipt: f.path_receipt,
      }));

    joined.set(id, {
      find,
      hidden_prompt: p.hidden_prompt,
      magic_inference: p.magic_inference,
      // stops only — the seed is phone-shaped and recomputable (decision 2)
      gradient: { stops: p.gradient.stops },
    });
  }
  return { joined, missing, droppedFinds };
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

  const convictions: Record<string, Conviction> = ConvictionsSchema.parse(
    JSON.parse(readFileSync(CONVICTIONS, "utf8")),
  );
  const matches = MatchesSchema.parse(JSON.parse(readFileSync(MATCHES, "utf8")));
  const convOf = (id: string): Conviction | null => convictions[id] ?? null;

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

  /* ---- 1d. the passport join, resolved BEFORE a single byte is written ----
   * The staleness verdict is a property of the whole population, so it has to be reached
   * before the write loop starts: failing half-way through would leave a people/ directory
   * where some records carry a passport and some do not, and nothing on disk would say why. */
  const { joined: passports, missing: passportMisses, droppedFinds } = loadPassports(ids);
  for (const id of passportMisses) {
    console.error(`WARN: no passport for ${id} — ${join(PASSPORTS_DIR, `${id}.json`)} is absent; the record ships passport: null`);
  }
  if (passportMisses.length > ids.length * PASSPORT_MISSING_MAX) {
    throw new EmitError(
      "PassportsStale",
      `${passportMisses.length} of ${ids.length} guests (${((100 * passportMisses.length) / ids.length).toFixed(1)}%) ` +
        `have no ${PASSPORTS_DIR}/<id>.json — above the ${(100 * PASSPORT_MISSING_MAX).toFixed(0)}% floor that separates ` +
        `a sparse dir from a stale one. Re-run scripts/generate-passports.ts before emitting.`,
    );
  }
  if (droppedFinds.length > 0) {
    console.error(`WARN: ${droppedFinds.length} passport find(s) point outside the emitted population — dropped, never repointed:`);
    for (const d of droppedFinds.slice(0, 8)) console.error(`      ${d}`);
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
  const highlightHist = new Map<string, number>();
  const edgeCounts: number[] = [];
  const pinMisses: string[] = [];
  const sheetRows: Record<string, string>[] = [];
  const extractionModel = convictionModel();
  const matchProvider = vectorProvider();

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

    writeFileSync(
      join(PEOPLE_DIR, `${me.id}.json`),
      `${JSON.stringify({
        personId: me.id,
        name: me.name,
        answers: g.answers,
        edges: personEdges,
        highlights,
        // honest provenance (law d): the artifact itself says which fields a human moved
        ...(stamped.length > 0 ? { _overridden: stamped } : {}),
      })}\n`,
    );
    if (stamped.length > 0) me._overridden = stamped;
    records += 1;

    /* ---- the enrichment sheet row: everything this bake decided, on one line ---- */
    const ov = overrides.get(me.id);
    const quoteFor = (tag: OverridableTag): string => {
      if (!c || c[tag] === null) return "";
      // an overridden tag's receipt was dropped with the tag — never re-attach it here
      if (overriddenFields.get(me.id)?.includes(tag)) return "";
      return c.quotes[TAG_QUOTE_FIELD[tag]] ?? "";
    };
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
    meta: {
      people: nodes.length,
      built: new Date().toISOString(),
      source: src.label,
      // which vector provider produced the SEEKS matches this bake reads — mirrors the
      // SEEKS rels' `_src="match:<provider>-v1"` (law d) so the artifact is self-describing
      // without a DB round trip. Same resolution lib/matches.ts uses for the actual matching
      // run: EMBED_PROVIDER at call time, default "gateway".
      matchProvider: vectorProvider(),
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
