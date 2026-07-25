/**
 * scripts/audit-graph.ts — THE TEETH for the party graph v2 (CLAUDE.md law c).
 *
 * Re-derives every claim the baked artifacts make, from the two sources that were never
 * allowed to lie: the raw CSV (via `loadGuests` — the SAME dedup/canonicalization the
 * pipeline used) and the Neo4j graph itself. Nothing here trusts `public/graph`.
 *
 * Six obligations, all fail-able:
 *   1. SPAN INTEGRITY   — every receipt quote is a BYTE-LITERAL substring of the cited
 *                         person's cited field. `answer.includes(quote)`, ZERO normalization:
 *                         the conviction pass snaps stored quotes to exact source spans
 *                         (commits d597e3c/a350174), so any mismatch is a real defect,
 *                         not a whitespace artifact. Two field shapes get their own rule:
 *                         school/company quote the canonical display OR this guest's own raw
 *                         sheet cell (re-read here per guest_id); a `title` receipt is the
 *                         COMPOSITE offer line `title — goal`, split on the joiner and each
 *                         half checked against its own field.
 *   2. COUNT INTEGRITY  — every number in a highlight ("one of N", "N people are looking
 *                         for you", caucus sizes) is recounted independently from
 *                         graph.json + the CSV and must match EXACTLY. A number we cannot
 *                         ground is a violation (dot grounded-counts law). Zero-count
 *                         claims must not exist at all (dignity: absence, never zero).
 *   3. DIGNITY FLOOR    — no record with <3 highlights or 0 edges; no `flags` vocabulary
 *                         ("missing-school", "conviction-guard-failed", …) in user-visible text.
 *   4. GRAPH INTEGRITY  — every `seek` edge (in graph.json AND in person records) exists as a
 *                         SEEKS rel in Neo4j with a matching `mutual` flag; every node id
 *                         exists as a :Person. Batched parameterized queries, 100/batch,
 *                         id-scoped (`p.id IN $ids`) — the graph also holds a legacy
 *                         population, so a global count would be meaningless.
 *   5. PII TRIPWIRE     — every emitted byte re-scanned for emails / gmail / .edu / phones /
 *                         luma.com, plus a bare "@" ANYWHERE outside the guests' own answer
 *                         text (a few guests name an Instagram handle in an answer, and that
 *                         text is theirs). Hits are reported by offset, NEVER echoed.
 *   6. POPULATION       — node count == the deduped CSV count (derived here, never hardcoded),
 *                         node fields == the canonical guest fields, meta.stages recounted.
 *
 * Exit codes:  0 clean (one-line summary) · 1 violations (named, file-scoped list)
 *              2 DEGRADED — `GuestsCsvMissing` / `Neo4jNotConfigured`, named, never faked.
 *
 * Env:
 *   GUESTS_CSV   (required) the real Luma export
 *   AUDIT_DIR    artifact root, default `public/graph` — point it at a copy to prove fail-ability
 *   SKIP_NEO4J=1 skip obligation 4 with a LOUD warning. OFFLINE DEV ONLY; a run that skips
 *                it says so in its summary line and never claims a full audit.
 *
 * Run:  GUESTS_CSV=… node --env-file=.env ./node_modules/.bin/tsx scripts/audit-graph.ts
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { z } from "zod";
import { loadGuests, type Guest } from "../lib/guests";
import { run, close, isConfigured, toNum, Neo4jNotConfigured } from "../lib/neo4j";
import { GUARD_FAILED_FLAG } from "../lib/conviction";

/* ───────────────────────────── config ───────────────────────────── */

const AUDIT_DIR = path.resolve(process.cwd(), process.env.AUDIT_DIR?.trim() || "public/graph");
const GRAPH_PATH = path.join(AUDIT_DIR, "graph.json");
const PEOPLE_DIR = path.join(AUDIT_DIR, "people");
const SKIP_NEO4J = process.env.SKIP_NEO4J === "1";
const BATCH = 100;
const MATCHES_PATH = path.resolve(process.cwd(), "data/graph-private/matches.json");
const CONVICTIONS_PATH = path.resolve(process.cwd(), "data/graph-private/convictions.json");

/** Score agreement tolerance between graph.json and the SEEKS rel (both are round4'd). */
const SCORE_EPS = 5e-4;

/** The answer fields a receipt may cite by name. */
const ANSWER_FIELDS = ["goal", "drew", "seeking", "inspiration", "favorite"] as const;
type AnswerField = (typeof ANSWER_FIELDS)[number];
const isAnswerField = (f: string): f is AnswerField =>
  (ANSWER_FIELDS as readonly string[]).includes(f);

/** Tag columns on a node, recounted for caucus claims. */
const TAG_KEYS = ["motive", "mission", "impact", "asp"] as const;
type TagKey = (typeof TAG_KEYS)[number];

/**
 * The emitter renders a closed-vocabulary tag as a phrase a guest would actually read, and
 * MOST phrases do not contain their tag ("prove-its-possible" → "prove it is possible",
 * "market-brand" → "build brands"). A count claim must be pinned to the group it NAMES, so
 * the audit needs the same tag→phrase table.
 *
 * Replicated here rather than imported, deliberately: `scripts/emit-graph.ts` is a script,
 * not a shared surface, and an audit that reads the subject's own constants proves nothing.
 * The failure direction is safe — if the emitter's vocabulary grows and this table does not,
 * the claim stops binding and the audit says `claim-names-wrong-group`, loudly. It never
 * silently accepts. Mirrors emit-graph.ts:128-181 (tags: task-4 conviction vocabulary).
 */
const TAG_PHRASE: Record<TagKey, Record<string, string>> = {
  motive: {
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
  },
  mission: {
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
  },
  impact: {
    "connect-people": "connect people",
    "inspire-action": "make people act",
    "make-people-feel-seen": "make people feel seen",
    "bring-joy": "bring joy",
    "create-escape-wonder": "create wonder",
    "keep-stories-alive": "keep stories alive",
    "provoke-thought": "provoke thought",
    "inform-truth": "inform",
  },
  asp: {
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
  },
};

/** Every spelling of a tag a claim is allowed to name it by (phrase, prettied, raw). */
function phrasesFor(k: TagKey, tag: string): string[] {
  const phrase = TAG_PHRASE[k][tag];
  const pretty = tag.replace(/[_-]+/g, " "); // the emitter's fallback for an unmapped tag
  return phrase ? [phrase, pretty, tag] : [pretty, tag];
}

/** Vocabulary that must never reach a guest's eyes. */
const FLAG_TOKENS = ["missing-school", "missing-answers", GUARD_FAILED_FLAG] as const;
const FLAG_PATTERNS: Array<[string, RegExp]> = [
  ["flag-token", new RegExp(`\\b(${FLAG_TOKENS.join("|")})\\b`, "i")],
  ["flag-shape", /\bmissing-[a-z][a-z-]*\b/i],
  ["flag-shape", /\bguard-failed\b/i],
  ["debug-leak", /\b(undefined|NaN)\b/],
  ["debug-leak", /\[object Object\]/],
];

/** PII patterns. Matches are reported by offset only — never echoed. */
const PII_SOURCES: Array<[string, string, string]> = [
  ["email", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "g"],
  ["gmail", "gmail", "gi"],
  ["edu-address", "\\.edu\\b", "gi"],
  ["phone", "(?<!\\d)(?:\\+?1[ .\\-]?)?(?:\\(\\d{3}\\)|\\d{3})[ .\\-]\\d{3}[ .\\-]\\d{4}(?!\\d)", "g"],
  ["luma-url", "luma\\.com", "gi"],
];
/** Fresh regexes per file — a /g pattern carries `lastIndex`, and sharing it across files is a trap. */
const piiPatterns = (): Array<[string, RegExp]> =>
  PII_SOURCES.map(([name, src, flags]) => [name, new RegExp(src, flags)] as [string, RegExp]);

/* ───────────────────────────── shapes ───────────────────────────── */

const Pos = z.tuple([z.number(), z.number()]);

const NodeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    title: z.string(),
    school: z.string().nullable(),
    company: z.string().nullable(),
    free: z.boolean(),
    motive: z.string().nullable(),
    mission: z.string().nullable(),
    impact: z.string().nullable(),
    asp: z.string().nullable(),
    deg: z.number(),
    pos: z.object({ web: Pos, why: Pos, seek: Pos }),
  })
  .passthrough();
type GraphNode = z.infer<typeof NodeSchema>;

const EdgeSchema = z
  .object({
    s: z.string().min(1),
    t: z.string().min(1),
    type: z.enum(["school", "company", "why", "seek"]),
    via: z.string(),
    m: z.boolean().optional(),
    score: z.number().optional(),
  })
  .passthrough();

const GraphSchema = z
  .object({
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    meta: z
      .object({
        people: z.number(),
        built: z.string(),
        counts: z.record(z.number()),
        stages: z
          .object({
            rows: z.number(),
            approved: z.number(),
            unique: z.number(),
            schools: z.number(),
            companies: z.number(),
            convictions: z.number(),
            seekEdges: z.number(),
            mutuals: z.number(),
            whyEdges: z.number(),
          })
          .passthrough(),
        guestIds: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();
type GraphDoc = z.infer<typeof GraphSchema>;

const SideSchema = z.object({ field: z.string(), quote: z.string() }).passthrough();
const PersonEdgeSchema = z
  .object({
    targetId: z.string().min(1),
    type: z.string().min(1),
    direction: z.string().optional(),
    strength: z.number().optional(),
    via: z.string().optional(),
    receipt: z
      .object({ yours: SideSchema.optional(), theirs: SideSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
type PersonEdge = z.infer<typeof PersonEdgeSchema>;

const HighlightSchema = z
  .object({ kind: z.string(), text: z.string(), targets: z.array(z.string()).optional() })
  .passthrough();
type Highlight = z.infer<typeof HighlightSchema>;

const PersonSchema = z
  .object({
    personId: z.string().min(1),
    name: z.string(),
    storyline: z.string().optional(),
    answers: z
      .object({
        goal: z.string(),
        drew: z.string(),
        seeking: z.string(),
        inspiration: z.string(),
        favorite: z.string(),
      })
      .passthrough(),
    edges: z.array(PersonEdgeSchema),
    highlights: z.array(HighlightSchema),
  })
  .passthrough();
type PersonRecord = z.infer<typeof PersonSchema>;

/* ─────────────────────────── violations ─────────────────────────── */

interface Violation {
  file: string;
  code: string;
  detail: string;
}
const violations: Violation[] = [];
const add = (file: string, code: string, detail: string): void => {
  violations.push({ file, code, detail });
};

/** DEGRADED exit — a named error, never a fake answer. */
function degraded(name: string, detail: string): never {
  console.error(`\nDEGRADED — ${name}: ${detail}`);
  console.error("[audit] inputs absent; no verdict rendered (exit 2).");
  process.exit(2);
}

/* ───────────────────────────── helpers ───────────────────────────── */

function rel(p: string): string {
  const r = path.relative(process.cwd(), p);
  // out-of-tree AUDIT_DIR (a corrupted copy, say) reads better absolute than as ../../../..
  return r === "" || r.startsWith("..") ? p : r;
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Quotes are printed guillemet-wrapped and truncated — receipts get long. */
function q(s: string, max = 72): string {
  const t = s.length > max ? `${s.slice(0, max)}…` : s;
  return `«${t.replace(/\n/g, "\\n")}»`;
}

/** Where two strings first differ — truncating both ends hides a one-character defect. */
function diverge(got: string, want: string): string {
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  const win = (s: string): string => q(s.slice(Math.max(0, i - 12), i + 24), 40);
  return `lengths ${got.length} vs ${want.length}, first difference at char ${i}: record ${win(got)} vs CSV ${win(want)}`;
}

/**
 * The byte-literal source strings a receipt on `field` may quote from.
 *
 * Answer fields resolve to the CSV answer verbatim. `school`/`company` resolve to the
 * canonical display value OR this guest's OWN raw sheet cell — the receipt card shows both
 * people's sheet text side by side, so "UCLA ‘28" is a stronger receipt than "UCLA", and the
 * raw cell is still that person's own bytes (it is re-read from the CSV here, per guest_id,
 * and it is by construction the cell that produced their canonical group). `title`
 * additionally admits the composed offer line the seek receipts use (`title — goal`).
 */
function sourcesFor(g: Guest, field: string, raw?: RawCells): string[] | null {
  if (isAnswerField(field)) return [g.answers[field]];
  switch (field) {
    case "school":
      return [g.school, raw?.school, raw?.school?.trim()].filter((s): s is string => Boolean(s));
    case "company":
      return [g.company, raw?.company, raw?.company?.trim()].filter((s): s is string => Boolean(s));
    case "name":
      return [g.name];
    case "hometown":
      return g.hometown === null ? [] : [g.hometown];
    // NOTE: "title" never reaches here — checkSide intercepts it for the composite rule.
    default:
      return null; // unknown field — the caller flags it
  }
}

/** The joiners the emitter uses to build the seek-offer line `title — goal`. */
const COMPOSITE_JOINERS = [" — ", " - "] as const;

/**
 * A `title` receipt on a seek edge is a COMPOSITE: `title — goal`, two fields joined.
 * Containment against a single field would be the wrong test (and a useless error message),
 * so split on the joiner and verify each half against ITS OWN source, exactly. Every joiner
 * occurrence is tried, because a guest's own title may contain a dash.
 */
function checkComposite(g: Guest, quote: string): { ok: boolean; why: string } {
  if (g.title !== "" && g.title.includes(quote)) return { ok: true, why: "" };
  const splits: Array<[string, string]> = [];
  for (const j of COMPOSITE_JOINERS) {
    let at = quote.indexOf(j);
    while (at >= 0) {
      splits.push([quote.slice(0, at), quote.slice(at + j.length)]);
      at = quote.indexOf(j, at + 1);
    }
  }
  if (splits.length === 0) {
    return { ok: false, why: `no joiner, and not a literal span of the title (${q(g.title || "<empty>")})` };
  }
  for (const [head, tail] of splits) {
    if (g.title.includes(head) && g.answers.goal.includes(tail)) return { ok: true, why: "" };
  }
  const [head, tail] = splits[0];
  const headOk = g.title.includes(head);
  const tailOk = g.answers.goal.includes(tail);
  const parts: string[] = [];
  if (!headOk) parts.push(`title half ${q(head, 48)} is not a span of ${q(g.title || "<empty>", 48)}`);
  if (!tailOk) parts.push(`goal half ${q(tail, 48)} is not a span of ${q(g.answers.goal || "<empty>", 48)}`);
  return { ok: false, why: parts.join("; ") };
}

/** Digit runs, comma groupings tolerated ("1,024" → 1024). */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Remove display strings (school/company/name/hometown) so their digits aren't read as claims. */
function stripKnown(text: string, strings: Array<string | null | undefined>): string {
  let out = text;
  for (const s of strings) if (s && s.length >= 2) out = out.split(s).join(" ");
  return out;
}

const pairKey = (s: string, t: string): string => `${s} ${t}`;

/* ───────────────────────── artifact loading ─────────────────────── */

interface Artifacts {
  graph: GraphDoc;
  graphRaw: string;
  people: Array<{ file: string; raw: string; rec: PersonRecord }>;
  badFiles: number;
}

async function loadArtifacts(): Promise<Artifacts | null> {
  if (!existsSync(GRAPH_PATH)) {
    add(rel(GRAPH_PATH), "GraphArtifactsMissing", "graph.json not found — run the emit leg first");
    return null;
  }
  let graphRaw: string;
  try {
    graphRaw = await readFile(GRAPH_PATH, "utf8");
  } catch (e) {
    add(rel(GRAPH_PATH), "GraphArtifactsMissing", `unreadable: ${(e as Error).message}`);
    return null;
  }
  let graphJson: unknown;
  try {
    graphJson = JSON.parse(graphRaw);
  } catch (e) {
    add(rel(GRAPH_PATH), "GraphSchemaInvalid", `not valid JSON: ${(e as Error).message}`);
    return null;
  }
  const parsed = GraphSchema.safeParse(graphJson);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 12)) {
      add(rel(GRAPH_PATH), "GraphSchemaInvalid", `${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return null;
  }

  if (!existsSync(PEOPLE_DIR)) {
    add(rel(PEOPLE_DIR), "GraphArtifactsMissing", "people/ directory not found — run the emit leg first");
    return null;
  }
  let names: string[];
  try {
    names = (await readdir(PEOPLE_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    add(rel(PEOPLE_DIR), "GraphArtifactsMissing", `unreadable: ${(e as Error).message}`);
    return null;
  }
  if (names.length === 0) {
    add(rel(PEOPLE_DIR), "GraphArtifactsMissing", "no person records to audit");
    return null;
  }

  const people: Artifacts["people"] = [];
  let badFiles = 0;
  for (const name of names) {
    const file = rel(path.join(PEOPLE_DIR, name));
    const raw = await readFile(path.join(PEOPLE_DIR, name), "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      add(file, "PersonSchemaInvalid", `not valid JSON: ${(e as Error).message}`);
      badFiles++;
      continue;
    }
    const p = PersonSchema.safeParse(json);
    if (!p.success) {
      for (const issue of p.error.issues.slice(0, 6)) {
        add(file, "PersonSchemaInvalid", `${issue.path.join(".") || "<root>"}: ${issue.message}`);
      }
      badFiles++;
      continue;
    }
    people.push({ file, raw, rec: p.data });
  }
  return { graph: parsed.data, graphRaw, people, badFiles };
}

/* ─────────────────── obligation 6: population + meta ────────────── */

export interface RawCells {
  school: string;
  company: string;
}

interface CsvStage {
  rows: number;
  approved: number;
  /** guestId -> the untouched sheet cells a school/company receipt is allowed to quote. */
  raw: Map<string, RawCells>;
}

/**
 * Independent re-read of the sheet. Deliberately NOT via `loadGuests` (which returns only
 * survivors, canonicalized): meta.stages.rows/approved are shown to guests in the entry
 * beats, and school/company receipts quote the RAW cell, so both need a counting path that
 * does not share the pipeline's code. The two column headers are re-declared here on
 * purpose — if the export renames them, this audit says so instead of silently agreeing.
 */
const RAW_SCHOOL_COL = "School? (e.g. USC '27)";
const RAW_COMPANY_COL = 'Company? (if you are freelance, just say "creative")';

async function csvStages(csvPath: string): Promise<CsvStage | null> {
  try {
    const Papa = (await import("papaparse")).default;
    let text = await readFile(csvPath, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const res = Papa.parse<Record<string, string | undefined>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => (h.charCodeAt(0) === 0xfeff ? h.slice(1) : h),
    });
    const rows = res.data.length;
    const approvedRows = res.data.filter(
      (r) => (r.approval_status ?? "").trim().toLowerCase() === "approved",
    );
    const headers = res.meta.fields ?? [];
    for (const col of [RAW_SCHOOL_COL, RAW_COMPANY_COL]) {
      if (!headers.includes(col)) {
        add(path.basename(csvPath), "csv-header-drift", `expected column ${q(col, 60)} is absent from the export`);
      }
    }
    // same dedup as the pipeline: approved only, first row per guest_id wins
    const raw = new Map<string, RawCells>();
    for (const r of approvedRows) {
      const id = (r.guest_id ?? "").trim();
      if (!id || raw.has(id)) continue;
      raw.set(id, { school: r[RAW_SCHOOL_COL] ?? "", company: r[RAW_COMPANY_COL] ?? "" });
    }
    return { rows, approved: approvedRows.length, raw };
  } catch (e) {
    // Fail LOUD and correctly attributed: swallowing this silently downgrades every
    // school/company receipt to canonical-only and reports ~1162 phantom quote violations.
    add(path.basename(csvPath), "csv-reparse-failed", `independent CSV re-read failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * The two private artifacts, read ONLY to corroborate claims the CSV and the graph cannot
 * settle on their own (the recorded doppelganger pairing, the openSeeker flag, meta.stages).
 * Absent (they are gitignored) → null, and the dependent checks say so in a note rather than
 * pretending. No span/count/graph obligation depends on them.
 */
interface Private {
  doppels: Set<string> | null;
  openSeekers: Set<string> | null;
  notes: string[];
}

function loadPrivate(): Private {
  const notes: string[] = [];
  let doppels: Set<string> | null = null;
  let openSeekers: Set<string> | null = null;
  if (existsSync(MATCHES_PATH)) {
    try {
      const m = JSON.parse(readFileSync(MATCHES_PATH, "utf8")) as { doppels?: Array<{ a: string; b: string }> };
      doppels = new Set((m.doppels ?? []).flatMap((x) => [pairKey(x.a, x.b), pairKey(x.b, x.a)]));
    } catch {
      notes.push("matches.json unreadable — doppelganger claims uncorroborated");
    }
  } else notes.push("matches.json absent — doppelganger claims uncorroborated");
  if (existsSync(CONVICTIONS_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONVICTIONS_PATH, "utf8")) as Record<string, unknown>;
      const src = (raw.convictions ?? raw) as Record<string, { openSeeker?: boolean }>;
      openSeekers = new Set(Object.entries(src).filter(([, v]) => v && v.openSeeker === true).map(([k]) => k));
    } catch {
      notes.push("convictions.json unreadable — openSeeker claims uncorroborated");
    }
  } else notes.push("convictions.json absent — openSeeker claims uncorroborated");
  return { doppels, openSeekers, notes };
}

function auditPopulation(g: GraphDoc, guests: Guest[], byId: Map<string, Guest>, peopleFiles: string[]): void {
  const F = rel(GRAPH_PATH);
  const expected = guests.length; // derived from the CSV, never hardcoded

  if (g.nodes.length !== expected) {
    add(F, "population-mismatch", `nodes ${g.nodes.length} !== deduped CSV population ${expected}`);
  }
  if (peopleFiles.length !== expected) {
    add(rel(PEOPLE_DIR), "population-mismatch", `person records ${peopleFiles.length} !== deduped CSV population ${expected}`);
  }

  // bijection node.id <-> personId
  const nodeIds = new Set<string>();
  for (const n of g.nodes) {
    if (nodeIds.has(n.id)) add(F, "duplicate-node-id", `node id "${n.id}" appears more than once`);
    nodeIds.add(n.id);
  }
  const unknown = [...nodeIds].filter((id) => !byId.has(id));
  const absent = guests.filter((x) => !nodeIds.has(x.personId)).map((x) => x.personId);
  if (unknown.length) {
    add(F, "node-not-in-csv", `${unknown.length} node id(s) absent from the CSV population: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}`);
  }
  if (absent.length) {
    add(F, "guest-not-in-graph", `${absent.length} CSV guest(s) missing a node: ${absent.slice(0, 5).join(", ")}${absent.length > 5 ? ", …" : ""}`);
  }

  // node fields must be the canonical guest fields, byte for byte
  let fieldMismatches = 0;
  for (const n of g.nodes) {
    const guest = byId.get(n.id);
    if (!guest) continue;
    const checks: Array<[string, unknown, unknown]> = [
      ["name", n.name, guest.name],
      ["title", n.title, guest.title],
      ["school", n.school, guest.school],
      ["company", n.company, guest.company],
      ["free", n.free, guest.isFreelance],
    ];
    for (const [field, got, want] of checks) {
      if (got !== want && fieldMismatches < 20) {
        fieldMismatches++;
        add(F, "node-field-mismatch", `${n.id}.${field}: graph ${JSON.stringify(got)} !== CSV ${JSON.stringify(want)}`);
      }
    }
    if (!Number.isInteger(n.deg) || n.deg < 0) {
      add(F, "node-field-mismatch", `${n.id}.deg is not a non-negative integer: ${n.deg}`);
    }
  }

  // edge endpoints resolve, and each structural edge is corroborated by its own source
  const nodeOf = new Map(g.nodes.map((n) => [n.id, n]));
  for (const [i, e] of g.edges.entries()) {
    if (!nodeIds.has(e.s) || !nodeIds.has(e.t)) {
      add(F, "dangling-edge", `edges[${i}] ${e.s}->${e.t} (${e.type}): endpoint not in nodes`);
      continue;
    }
    if (e.s === e.t) add(F, "self-edge", `edges[${i}] ${e.s} points at itself (${e.type})`);
    const a = byId.get(e.s);
    const b = byId.get(e.t);
    if (e.type === "school" && a && b && (a.school === null || a.school !== b.school)) {
      add(F, "edge-not-corroborated", `edges[${i}] ${e.s}->${e.t} claims a school tie; CSV says ${JSON.stringify(a.school)} vs ${JSON.stringify(b.school)}`);
    }
    if (e.type === "company" && a && b && (a.company === null || a.company !== b.company)) {
      add(F, "edge-not-corroborated", `edges[${i}] ${e.s}->${e.t} claims a company tie; CSV says ${JSON.stringify(a.company)} vs ${JSON.stringify(b.company)}`);
    }
    if (e.type === "why") {
      const na = nodeOf.get(e.s);
      const nb = nodeOf.get(e.t);
      if (na && nb && TAG_KEYS.every((k) => na[k] === null || na[k] !== nb[k])) {
        add(F, "edge-not-corroborated", `edges[${i}] ${e.s}->${e.t} claims a conviction tie, but they share no motive/mission/impact/aspiration tag`);
      }
    }
  }
}

function auditMeta(g: GraphDoc, guests: Guest[], stages: CsvStage | null): string[] {
  const F = rel(GRAPH_PATH);
  const notes: string[] = [];
  const m = g.meta;
  const expected = guests.length;

  if (m.people !== g.nodes.length) add(F, "meta-count-mismatch", `meta.people ${m.people} !== nodes ${g.nodes.length}`);
  if (m.counts.nodes !== undefined && m.counts.nodes !== g.nodes.length) {
    add(F, "meta-count-mismatch", `meta.counts.nodes ${m.counts.nodes} !== nodes ${g.nodes.length}`);
  }
  if (m.counts.edges !== undefined && m.counts.edges !== g.edges.length) {
    add(F, "meta-count-mismatch", `meta.counts.edges ${m.counts.edges} !== edges ${g.edges.length}`);
  }
  if (Number.isNaN(Date.parse(m.built))) add(F, "meta-count-mismatch", `meta.built is not a date: ${q(m.built)}`);

  const s = m.stages;
  if (s.unique !== expected) add(F, "stage-count-mismatch", `meta.stages.unique ${s.unique} !== deduped CSV ${expected}`);
  if (stages) {
    if (s.rows !== stages.rows) add(F, "stage-count-mismatch", `meta.stages.rows ${s.rows} !== CSV data rows ${stages.rows}`);
    if (s.approved !== stages.approved) add(F, "stage-count-mismatch", `meta.stages.approved ${s.approved} !== CSV approved rows ${stages.approved}`);
  } else {
    notes.push("stage recount skipped for rows/approved (CSV re-parse failed)");
  }
  const schools = new Set(guests.map((x) => x.school).filter((x): x is string => x !== null)).size;
  const companies = new Set(guests.map((x) => x.company).filter((x): x is string => x !== null)).size;
  if (s.schools !== schools) add(F, "stage-count-mismatch", `meta.stages.schools ${s.schools} !== distinct canonical schools ${schools}`);
  if (s.companies !== companies) add(F, "stage-count-mismatch", `meta.stages.companies ${s.companies} !== distinct canonical companies ${companies}`);
  if (s.rows < s.approved) add(F, "stage-count-mismatch", `meta.stages.rows ${s.rows} < approved ${s.approved}`);
  if (s.approved < s.unique) add(F, "stage-count-mismatch", `meta.stages.approved ${s.approved} < unique ${s.unique}`);
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === "number" && v < 0) add(F, "stage-count-mismatch", `meta.stages.${k} is negative: ${v}`);
  }
  if (s.convictions > s.unique) add(F, "stage-count-mismatch", `meta.stages.convictions ${s.convictions} > population ${s.unique}`);
  if (s.mutuals > s.seekEdges) add(F, "stage-count-mismatch", `meta.stages.mutuals ${s.mutuals} > seekEdges ${s.seekEdges}`);

  // guestIds: the Luma ids the drop-zone verifies a dragged CSV against
  const want = new Set(guests.map((x) => x.guestId));
  const got = new Set(m.guestIds);
  if (m.guestIds.length !== expected) add(F, "guest-ids-mismatch", `meta.guestIds ${m.guestIds.length} !== population ${expected}`);
  if (got.size !== m.guestIds.length) add(F, "guest-ids-mismatch", `meta.guestIds has ${m.guestIds.length - got.size} duplicate(s)`);
  const extra = [...got].filter((x) => !want.has(x));
  const missing = [...want].filter((x) => !got.has(x));
  if (extra.length) add(F, "guest-ids-mismatch", `${extra.length} guestId(s) not in the CSV approved set`);
  if (missing.length) add(F, "guest-ids-mismatch", `${missing.length} approved guestId(s) missing from meta.guestIds`);

  // Private-artifact corroboration for the stages the CSV can't prove.
  if (existsSync(MATCHES_PATH)) {
    try {
      const mm = JSON.parse(readFileSync(MATCHES_PATH, "utf8")) as { seeks?: Array<{ mutual?: boolean }> };
      const seeks = mm.seeks ?? [];
      const mutualEdges = seeks.filter((x) => x.mutual === true).length;
      if (s.seekEdges !== seeks.length) {
        add(F, "stage-count-mismatch", `meta.stages.seekEdges ${s.seekEdges} !== matches.json seeks ${seeks.length}`);
      }
      if (s.mutuals !== mutualEdges && s.mutuals * 2 !== mutualEdges) {
        add(F, "stage-count-mismatch", `meta.stages.mutuals ${s.mutuals} matches neither mutual-edge count ${mutualEdges} nor pair count ${mutualEdges / 2}`);
      }
    } catch {
      notes.push("matches.json unreadable — seekEdges/mutuals uncorroborated");
    }
  } else {
    notes.push("matches.json absent — seekEdges/mutuals uncorroborated");
  }
  if (existsSync(CONVICTIONS_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONVICTIONS_PATH, "utf8")) as unknown;
      const recs = convictionRecords(raw);
      // The emit stamps this stage AFTER the enrichment overrides replace tags
      // and drop their orphaned quotes (the override law in emit-graph.ts), so
      // the corroboration must re-derive THROUGH the same layer — the raw cache
      // alone would flag every mass override as a lie it isn't telling.
      const ovRecs = convictionRecords(applyOverrideQuoteDrops(raw));
      if (recs !== null) {
        const candidates = new Set([recs.total, recs.tagged, recs.clean, recs.quoted]);
        if (ovRecs !== null) for (const v of [ovRecs.tagged, ovRecs.clean, ovRecs.quoted]) candidates.add(v);
        if (!candidates.has(s.convictions)) {
          add(
            F,
            "stage-count-mismatch",
            `meta.stages.convictions ${s.convictions} matches no convictions.json reading ` +
              `(total ${recs.total}, tagged ${recs.tagged}, unflagged ${recs.clean}, receipted ${recs.quoted}` +
              `${ovRecs ? `, override-adjusted receipted ${ovRecs.quoted}` : ""})`,
          );
        }
      }
    } catch {
      notes.push("convictions.json unreadable — convictions stage uncorroborated");
    }
  } else {
    notes.push("convictions.json absent — convictions stage uncorroborated");
  }
  return notes;
}

/**
 * Replay the emit's override layer over the RAW conviction cache: replace the
 * four overridable tags and drop the quote behind each REPLACED tag unless an
 * untouched tag still cites that answer field — the exact law implemented in
 * scripts/emit-graph.ts (§1c). Deliberately tolerant of a missing/blank
 * overrides file (→ the cache is returned untouched): the corroboration this
 * feeds treats the overridden reading as one more candidate, never a pardon —
 * a count matching NO reading still fails loud.
 */
function applyOverrideQuoteDrops(raw: unknown): unknown {
  const ovPath = path.resolve(process.cwd(), process.env.OVERRIDES_PATH?.trim() || "data/graph-overrides.csv");
  if (!existsSync(ovPath) || !raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  let text = readFileSync(ovPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) return raw; // emit fails loud on this long before an audit runs

  const TAGS = ["motive", "mission", "impact", "aspiration"] as const;
  const FIELD: Record<(typeof TAGS)[number], string> = { motive: "drew", mission: "goal", impact: "goal", aspiration: "goal" };
  const src = ((raw as Record<string, unknown>).convictions ?? raw) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [id, rec] of Object.entries(src)) {
    out[id] = rec && typeof rec === "object" ? { ...(rec as object), quotes: { ...((rec as { quotes?: object }).quotes ?? {}) } } : rec;
  }
  for (const row of parsed.data) {
    const id = (row.person_id ?? "").trim();
    const rec = out[id] as { quotes: Record<string, string> } & Record<string, unknown>;
    if (!id || !rec || typeof rec !== "object") continue;
    const applied: (typeof TAGS)[number][] = [];
    for (const t of TAGS) {
      const want = (row[t] ?? "").trim();
      if (want === "" || rec[t] === want) continue;
      rec[t] = want;
      applied.push(t);
    }
    if (applied.length === 0) continue;
    const stillCited = new Set(TAGS.filter((t) => rec[t] != null && !applied.includes(t)).map((t) => FIELD[t]));
    for (const t of applied) {
      if (!stillCited.has(FIELD[t])) delete rec.quotes[FIELD[t]];
    }
  }
  return out;
}

function convictionRecords(
  raw: unknown,
): { total: number; tagged: number; clean: number; quoted: number } | null {
  const entries: Array<Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : raw && typeof raw === "object"
      ? Object.values(
          ((raw as Record<string, unknown>).convictions ?? raw) as Record<string, unknown>,
        ).filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
      : [];
  if (entries.length === 0) return null;
  const tagged = entries.filter((c) =>
    ["motive", "mission", "impact", "aspiration"].some((k) => c[k] != null),
  ).length;
  const clean = entries.filter((c) => !Array.isArray(c.flags) || c.flags.length === 0).length;
  // "a conviction with a receipt" — the strictest defensible reading of the stage
  const quoted = entries.filter(
    (c) => c.quotes && typeof c.quotes === "object" && Object.keys(c.quotes as object).length > 0,
  ).length;
  return { total: entries.length, tagged, clean, quoted };
}

/* ─────────────── derived quantities (independent recount) ───────── */

interface Derived {
  schoolGroup: Map<string, number>;
  companyGroup: Map<string, number>;
  hometownGroup: Map<string, number>;
  tagGroup: Record<TagKey, Map<string, number>>;
  inbound: Map<string, Set<string>>;
  outbound: Map<string, Set<string>>;
  mutual: Map<string, Set<string>>;
}

function derive(g: GraphDoc, guests: Guest[]): Derived {
  const count = <T>(xs: T[], key: (x: T) => string | null): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) {
      const k = key(x);
      if (k !== null && k !== "") m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };

  const tagGroup = {} as Record<TagKey, Map<string, number>>;
  for (const k of TAG_KEYS) tagGroup[k] = count(g.nodes, (n) => n[k]);

  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();
  const mutual = new Map<string, Set<string>>();
  const push = (m: Map<string, Set<string>>, k: string, v: string): void => {
    const s = m.get(k) ?? new Set<string>();
    s.add(v);
    m.set(k, s);
  };
  const directed = new Set(g.edges.filter((e) => e.type === "seek").map((e) => pairKey(e.s, e.t)));
  for (const e of g.edges) {
    if (e.type !== "seek") continue;
    push(outbound, e.s, e.t);
    push(inbound, e.t, e.s);
    if (e.m === true) {
      push(mutual, e.s, e.t);
      push(mutual, e.t, e.s);
      // a mutual pair emitted once still means the reverse direction exists
      if (!directed.has(pairKey(e.t, e.s))) {
        push(outbound, e.t, e.s);
        push(inbound, e.s, e.t);
      }
    }
  }

  return {
    schoolGroup: count(guests, (x) => x.school),
    companyGroup: count(guests, (x) => x.company),
    hometownGroup: count(guests, (x) => x.hometown),
    tagGroup,
    inbound,
    outbound,
    mutual,
  };
}

/* ──────────────── obligations 1–3: the person records ───────────── */

interface PersonAudit {
  receipts: number;
  counts: number;
  seekPairs: Array<{ s: string; t: string; expectMutual: boolean | null; origin: string }>;
}

function auditPerson(
  file: string,
  rec: PersonRecord,
  byId: Map<string, Guest>,
  nodeById: Map<string, GraphNode>,
  d: Derived,
  totalPeople: number,
  rawCells: Map<string, RawCells>,
  doppels: Set<string> | null,
  openSeekers: Set<string> | null,
): PersonAudit {
  const out: PersonAudit = { receipts: 0, counts: 0, seekPairs: [] };
  const base = path.basename(file, ".json");
  if (base !== rec.personId) add(file, "person-id-mismatch", `filename "${base}" !== personId "${rec.personId}"`);

  const me = byId.get(rec.personId);
  if (!me) {
    add(file, "person-not-in-csv", `personId "${rec.personId}" is not in the deduped CSV population`);
    return out;
  }
  const node = nodeById.get(rec.personId);
  if (!node) add(file, "person-not-in-graph", `personId "${rec.personId}" has no node in graph.json`);

  if (rec.name !== me.name) add(file, "person-field-mismatch", `name ${q(rec.name)} !== CSV ${q(me.name)}`);
  for (const f of ANSWER_FIELDS) {
    if (rec.answers[f] !== me.answers[f]) {
      add(file, "answer-not-verbatim", `answers.${f} is not the CSV text — ${diverge(rec.answers[f], me.answers[f])}`);
    }
  }

  /* --- obligation 3: dignity floor --- */
  if (rec.edges.length === 0) add(file, "dignity-floor", "0 edges — nobody gets an empty record");
  if (rec.highlights.length < 3) add(file, "dignity-floor", `${rec.highlights.length} highlight(s) — floor is 3`);

  /* --- obligation 1: span integrity --- */
  const checkSide = (
    idx: number,
    e: PersonEdge,
    side: "yours" | "theirs",
    guest: Guest | undefined,
    who: string,
  ): void => {
    const r = e.receipt?.[side];
    if (!r) return;
    out.receipts++;
    if (!guest) {
      add(file, "receipt-subject-unknown", `edges[${idx}].receipt.${side} cites ${who}, who is not in the CSV population`);
      return;
    }
    if (r.quote === "") {
      add(file, "receipt-quote-empty", `edges[${idx}].receipt.${side} (${who}) has an empty quote`);
      return;
    }
    // receipts cite a personId, never a sheet row — row numbers are not stable provenance
    for (const k of ["row", "rowNumber", "line", "csvRow"]) {
      if (k in r) add(file, "receipt-cites-row", `edges[${idx}].receipt.${side} carries "${k}" — receipts cite personId, not sheet rows`);
    }
    if (r.field === "title") {
      // composite `title — goal`: each half verified against its own field, exactly
      const v = checkComposite(guest, r.quote);
      if (!v.ok) {
        add(file, "receipt-quote-not-verbatim", `edges[${idx}] (${e.type} → ${e.targetId}) receipt.${side}: composite ${q(r.quote)} — ${v.why}`);
      }
      return;
    }
    const sources = sourcesFor(guest, r.field, rawCells.get(guest.guestId));
    if (sources === null) {
      add(file, "receipt-field-unknown", `edges[${idx}].receipt.${side} cites unknown field "${r.field}"`);
      return;
    }
    // EXACT: byte-literal containment, ZERO normalization (quotes are snapped to source spans).
    if (!sources.some((s) => s !== "" && s.includes(r.quote))) {
      add(
        file,
        "receipt-quote-not-verbatim",
        `edges[${idx}] (${e.type} → ${e.targetId}) receipt.${side}: ${q(r.quote)} is not a literal span of ${who}'s "${r.field}" (${q(sources[0] ?? "<empty>")})`,
      );
    }
  };

  for (const [i, e] of rec.edges.entries()) {
    if (e.targetId === rec.personId) add(file, "self-edge", `edges[${i}] points at its own person`);
    const target = byId.get(e.targetId);
    if (!target) add(file, "dangling-edge", `edges[${i}] targetId "${e.targetId}" is not in the CSV population`);
    else if (!nodeById.has(e.targetId)) add(file, "dangling-edge", `edges[${i}] targetId "${e.targetId}" has no node in graph.json`);

    if (!["school", "company", "why", "seek"].includes(e.type)) {
      add(file, "edge-type-unknown", `edges[${i}].type "${e.type}" is off-contract`);
    }
    if (e.via !== undefined && e.via.trim() === "") add(file, "edge-via-empty", `edges[${i}] has an empty via`);
    // I2: an edge without a receipt is an unbacked claim — law (c) admits no receipt-exempt type
    if (!e.receipt || (!e.receipt.yours && !e.receipt.theirs)) {
      add(file, "edge-receipt-missing", `edges[${i}] (${e.type} → ${e.targetId}) carries no receipt — every edge must be provable`);
    }
    if (e.strength !== undefined && (e.strength < 0 || e.strength > 1)) {
      add(file, "edge-strength-range", `edges[${i}].strength ${e.strength} outside 0..1`);
    }

    // structural edges must be corroborated by the CSV, not merely asserted
    if (target) {
      if (e.type === "school" && (me.school === null || me.school !== target.school)) {
        add(file, "edge-not-corroborated", `edges[${i}] claims a school tie but CSV says ${JSON.stringify(me.school)} vs ${JSON.stringify(target.school)}`);
      }
      if (e.type === "company" && (me.company === null || me.company !== target.company)) {
        add(file, "edge-not-corroborated", `edges[${i}] claims a company tie but CSV says ${JSON.stringify(me.company)} vs ${JSON.stringify(target.company)}`);
      }
      // I2: a why-edge asserts a shared conviction — the tags are on the nodes, so prove it
      if (e.type === "why") {
        const mineNode = node;
        const theirs = nodeById.get(e.targetId);
        const shared = mineNode && theirs ? TAG_KEYS.filter((k) => mineNode[k] !== null && mineNode[k] === theirs[k]) : [];
        if (mineNode && theirs && shared.length === 0) {
          add(file, "edge-not-corroborated", `edges[${i}] claims a conviction tie to ${e.targetId}, but they share no motive/mission/impact/aspiration tag`);
        }
      }
    }

    if (e.type === "seek") {
      const dir = (e.direction ?? "").toLowerCase();
      if (/^mut/.test(dir)) {
        out.seekPairs.push({ s: rec.personId, t: e.targetId, expectMutual: true, origin: file });
        out.seekPairs.push({ s: e.targetId, t: rec.personId, expectMutual: true, origin: file });
      } else if (/^in/.test(dir)) {
        out.seekPairs.push({ s: e.targetId, t: rec.personId, expectMutual: null, origin: file });
      } else if (/^out/.test(dir)) {
        out.seekPairs.push({ s: rec.personId, t: e.targetId, expectMutual: null, origin: file });
      } else {
        add(file, "seek-direction-unknown", `edges[${i}].direction ${q(e.direction ?? "<absent>")} is not mutual|inbound|outbound`);
      }
    }

    checkSide(i, e, "yours", me, "this person");
    checkSide(i, e, "theirs", target, e.targetId);
  }

  /* --- obligation 2: count integrity --- *
   * Every claim BINDS to exactly one named group, re-derived here, or it fails. There is no
   * "matches any of my group sizes" net: that let a cross-group substitution through
   * ("One of 36 here to prove it is possible" when the true caucus was 6). Binding is by the
   * emitter's own claim TEMPLATE — the sentence names its group, so the audit reads the name
   * out of the sentence and checks that group and no other. A template this audit cannot
   * recognise is `unbindable-claim`, never a pass. */
  const schoolN = me.school ? d.schoolGroup.get(me.school) ?? 0 : undefined;
  const companyN = me.company ? d.companyGroup.get(me.company) ?? 0 : undefined;
  const tagN: Partial<Record<TagKey, number>> = {};
  if (node) {
    for (const k of TAG_KEYS) {
      const v = node[k];
      if (v) tagN[k] = d.tagGroup[k].get(v) ?? 0;
    }
  }
  const inboundSet = d.inbound.get(rec.personId) ?? new Set<string>();
  const mutualSet = d.mutual.get(rec.personId) ?? new Set<string>();
  const towardMeEdges = rec.edges.filter(
    (e) => e.type === "seek" && /^(mut|in)/.test((e.direction ?? "").toLowerCase()),
  ).length;

  for (let i = 0; i < rec.highlights.length; i++) {
    const h: Highlight = rec.highlights[i];
    const where = `highlights[${i}] (${h.kind})`;

    if (h.text.trim() === "") {
      add(file, "highlight-empty", `${where} has no text`);
      continue;
    }
    // flag vocabulary must never reach a guest
    for (const [code, re] of FLAG_PATTERNS) {
      const hit = re.exec(h.text);
      if (hit) add(file, `highlight-${code}`, `${where} shows internal vocabulary: ${q(hit[0], 40)}`);
    }
    // absence, never zero
    const stripped = stripKnown(h.text, [me.school, me.company, me.hometown, me.name, me.title]);
    const nums = numbersIn(stripped);
    if (nums.includes(0) || /\bnobody\b|\bno one\b|\bzero\b/i.test(h.text)) {
      add(file, "zero-count-claim", `${where} makes a zero claim: ${q(h.text)}`);
    }
    const targets = h.targets ?? [];
    for (const t of targets) {
      if (!nodeById.has(t)) add(file, "highlight-target-dangling", `${where} targets "${t}", which has no node`);
      if (t === rec.personId) add(file, "highlight-target-dangling", `${where} targets its own person`);
    }

    const kind = h.kind.toLowerCase();
    /** M1: the CLAIM is the leading number; a trailing number is a separate assertion. */
    const lead = nums.length > 0 ? nums[0] : undefined;
    const bind = (group: string, want: number | undefined): void => {
      out.counts++;
      if (lead === undefined) {
        add(file, "unbindable-claim", `${where} binds to ${group} but carries no number: ${q(h.text)}`);
      } else if (want === undefined) {
        add(file, "count-not-grounded", `${where} claims ${lead} for ${group}, which this person does not have: ${q(h.text)}`);
      } else if (lead !== want) {
        add(file, "count-mismatch", `${where} says ${lead} for ${group}; independent recount says ${want}: ${q(h.text)}`);
      }
    };
    /** The claim must NAME the group it counts — a renamed label is a fabricated claim. */
    const namesTag = (k: TagKey): boolean => {
      const tag = node?.[k];
      return tag ? phrasesFor(k, tag).some((ph) => h.text.includes(ph)) : false;
    };

    switch (kind) {
      case "sought-by": {
        bind(`inbound seek edges into ${rec.personId}`, inboundSet.size);
        if (nums.length > 2) {
          add(file, "unbindable-claim", `${where} carries ${nums.length} numbers; the template has at most 2: ${q(h.text)}`);
        } else if (nums.length === 2) {
          // "The closest N are listed above." — N is how many are actually listed
          out.counts++;
          if (nums[1] !== towardMeEdges) {
            add(file, "count-mismatch", `${where} says ${nums[1]} are listed above; the record carries ${towardMeEdges} inbound/mutual edge(s)`);
          }
          if (lead !== undefined && nums[1] >= lead) {
            add(file, "count-not-grounded", `${where} lists ${nums[1]} of a claimed ${lead} — the tail is only true when the claim exceeds it`);
          }
        }
        for (const t of targets) {
          if (!inboundSet.has(t)) add(file, "count-not-grounded", `${where} names ${t} as seeking this person, but no such seek edge exists`);
        }
        if (lead !== undefined && targets.length > lead) {
          add(file, "count-mismatch", `${where} lists ${targets.length} target(s) but claims ${lead}`);
        }
        break;
      }
      case "mutual": {
        // "You are looking for each other:" (exactly 1) or "N people here are looking for you…"
        out.counts++;
        if (lead === undefined) {
          if (mutualSet.size !== 1) {
            add(file, "count-mismatch", `${where} uses the singular template; recount of mutual seek edges says ${mutualSet.size}`);
          }
        } else if (lead !== mutualSet.size) {
          add(file, "count-mismatch", `${where} says ${lead}; recount of mutual seek edges says ${mutualSet.size}: ${q(h.text)}`);
        }
        for (const t of targets) {
          if (!mutualSet.has(t)) add(file, "count-not-grounded", `${where} names ${t} as mutual, but no mutual seek edge exists`);
        }
        break;
      }
      case "one-of-n": {
        // `One of N from <school> in the room.` | `One of N at <company> tonight.`
        const asSchool = /^One of \d[\d,]* from (.+) in the room\.$/.exec(h.text);
        const asCompany = /^One of \d[\d,]* at (.+) tonight\.$/.exec(h.text);
        if (asSchool) {
          if (asSchool[1] !== me.school) {
            add(file, "claim-names-wrong-group", `${where} names school ${q(asSchool[1], 40)}; the CSV says this person's school is ${q(me.school ?? "<none>", 40)}`);
            out.counts++;
          } else bind(`school "${me.school}"`, schoolN);
        } else if (asCompany) {
          if (asCompany[1] !== me.company) {
            add(file, "claim-names-wrong-group", `${where} names company ${q(asCompany[1], 40)}; the CSV says this person's company is ${q(me.company ?? "<none>", 40)}`);
            out.counts++;
          } else bind(`company "${me.company}"`, companyN);
        } else {
          add(file, "unbindable-claim", `${where} matches neither one-of-n template, so its group cannot be named: ${q(h.text)}`);
          out.counts++;
        }
        break;
      }
      case "conviction-caucus": {
        // `One of N here to <mission>.` | `One of N who want the work to <impact>.`
        const isMission = / here to /.test(h.text);
        const isImpact = /who want the work to /.test(h.text);
        const k: TagKey | null = isMission ? "mission" : isImpact ? "impact" : null;
        if (k === null) {
          add(file, "unbindable-claim", `${where} matches neither caucus template: ${q(h.text)}`);
          out.counts++;
        } else if (!node?.[k]) {
          add(file, "count-not-grounded", `${where} claims a ${k} caucus, but this person has no ${k} tag: ${q(h.text)}`);
          out.counts++;
        } else if (!namesTag(k)) {
          add(file, "claim-names-wrong-group", `${where} does not name this person's ${k} "${node[k]}" (${q(phrasesFor(k, node[k] as string)[0], 40)}): ${q(h.text)}`);
          out.counts++;
        } else bind(`${k} "${node[k]}"`, tagN[k]);
        break;
      }
      case "motive": {
        // `One of N who came to this through <motive>.`
        if (!node?.motive) {
          add(file, "count-not-grounded", `${where} claims a motive group, but this person has no motive tag: ${q(h.text)}`);
          out.counts++;
        } else if (!namesTag("motive")) {
          add(file, "claim-names-wrong-group", `${where} does not name this person's motive "${node.motive}" (${q(phrasesFor("motive", node.motive)[0], 40)}): ${q(h.text)}`);
          out.counts++;
        } else bind(`motive "${node.motive}"`, tagN.motive);
        break;
      }
      case "craft": {
        // `One of N aiming to <asp>.` | `One of N still working out where they land.` (undecided)
        const undecidedTemplate = /still working out where they land/.test(h.text);
        if (!node?.asp) {
          add(file, "count-not-grounded", `${where} claims a craft group, but this person has no aspiration tag: ${q(h.text)}`);
          out.counts++;
        } else if (node.asp === "undecided" ? !undecidedTemplate : !namesTag("asp")) {
          add(file, "claim-names-wrong-group", `${where} does not name this person's aspiration "${node.asp}" (${q(phrasesFor("asp", node.asp)[0], 40)}): ${q(h.text)}`);
          out.counts++;
        } else if (node.asp !== "undecided" && undecidedTemplate) {
          add(file, "claim-names-wrong-group", `${where} uses the undecided template but this person's aspiration is "${node.asp}"`);
          out.counts++;
        } else bind(`aspiration "${node.asp}"`, tagN.asp);
        break;
      }
      case "room": {
        bind("the room", totalPeople);
        break;
      }
      case "hometown": {
        // `Came from <hometown>.` — a factual assertion, checked like a receipt (I4)
        out.counts++;
        const said = /^Came from (.+)\.$/.exec(h.text);
        if (me.hometown === null) {
          add(file, "fact-not-grounded", `${where} asserts a hometown, but the CSV has none for this person: ${q(h.text)}`);
        } else if (said) {
          if (said[1] !== me.hometown) {
            add(file, "fact-not-grounded", `${where} says ${q(said[1], 40)}; the CSV hometown is ${q(me.hometown, 40)}`);
          }
        } else if (!h.text.includes(me.hometown)) {
          add(file, "fact-not-grounded", `${where} does not contain the CSV hometown ${q(me.hometown, 40)}: ${q(h.text)}`);
        }
        if (numbersIn(stripKnown(h.text, [me.hometown])).length > 0) {
          add(file, "unbindable-claim", `${where} carries a number outside the hometown: ${q(h.text)}`);
        }
        break;
      }
      case "doppelganger": {
        out.counts++;
        if (targets.length !== 1) {
          add(file, "fact-not-grounded", `${where} must name exactly one nearest person, names ${targets.length}`);
        } else if (doppels !== null && !doppels.has(pairKey(rec.personId, targets[0])) && !doppels.has(pairKey(targets[0], rec.personId))) {
          add(file, "fact-not-grounded", `${where} names ${targets[0]} as the closest answers, which is not the recorded doppelganger pair`);
        }
        if (nums.length > 0) add(file, "unbindable-claim", `${where} carries a number the template has no place for: ${q(h.text)}`);
        break;
      }
      case "open": {
        out.counts++;
        if (openSeekers !== null && !openSeekers.has(rec.personId)) {
          add(file, "fact-not-grounded", `${where} says this person is open to meeting anyone; the conviction pass did not mark them openSeeker`);
        }
        if (nums.length > 0) add(file, "unbindable-claim", `${where} carries a number the template has no place for: ${q(h.text)}`);
        break;
      }
      default: {
        add(file, "unbindable-claim", `${where} is a highlight kind this audit cannot bind to a group — it must be taught the template before it can ship: ${q(h.text)}`);
        out.counts++;
      }
    }
  }

  // via + storyline are user-visible too
  for (const [i, e] of rec.edges.entries()) {
    if (!e.via) continue;
    for (const [code, re] of FLAG_PATTERNS) {
      const hit = re.exec(e.via);
      if (hit) add(file, `via-${code}`, `edges[${i}].via shows internal vocabulary: ${q(hit[0], 40)}`);
    }
  }
  if (rec.storyline) {
    for (const [code, re] of FLAG_PATTERNS) {
      const hit = re.exec(rec.storyline);
      if (hit) add(file, `storyline-${code}`, `storyline shows internal vocabulary: ${q(hit[0], 40)}`);
    }
  }

  return out;
}

/* ─────────────── obligation 5: the PII tripwire ─────────────────── */

function auditPii(file: string, raw: string): void {
  for (const [name, re] of piiPatterns()) {
    let hits = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null && hits < 3) {
      hits++;
      add(file, "pii-tripwire", `${name} pattern at byte ${m.index} (length ${m[0].length}) — value withheld`);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (hits > 0) {
      const total = raw.match(re)?.length ?? hits;
      if (total > hits) add(file, "pii-tripwire", `${name}: ${total} total hit(s) in this file`);
    }
  }
}

/**
 * A bare "@" is a leak everywhere EXCEPT inside the guests' own answer text — a handful of
 * guests name their Instagram handle in an answer, and that text is theirs, verbatim, by
 * design. So this scan skips answer values and the receipt quotes that are answer spans
 * (including the `title — goal` composite, whose tail IS the goal answer), and fails on an
 * "@" anywhere else. Email-shaped strings still fail everywhere, answers included.
 */
function auditBareAt(file: string, texts: Array<[string, string | undefined]>): void {
  for (const [where, text] of texts) {
    if (!text) continue;
    const at = text.indexOf("@");
    if (at >= 0) {
      add(file, "pii-tripwire", `bare "@" in ${where} at char ${at} — outside the guests' own answer text; value withheld`);
    }
  }
}

/** The strings in a person record that are NOT the guest's own answer text. */
function nonAnswerText(rec: PersonRecord): Array<[string, string | undefined]> {
  const out: Array<[string, string | undefined]> = [
    ["name", rec.name],
    ["storyline", rec.storyline],
  ];
  for (const [i, e] of rec.edges.entries()) {
    out.push([`edges[${i}].via`, e.via]);
    for (const side of ["yours", "theirs"] as const) {
      const r = e.receipt?.[side];
      // answer spans and the title-composite (whose tail is a goal span) are the guest's own words
      if (r && !isAnswerField(r.field) && r.field !== "title") {
        out.push([`edges[${i}].receipt.${side}`, r.quote]);
      }
    }
  }
  for (const [i, h] of rec.highlights.entries()) out.push([`highlights[${i}].text`, h.text]);
  return out;
}

/* ──────────── obligation 4: graph integrity vs Neo4j ────────────── */

interface SeekClaim {
  s: string;
  t: string;
  expectMutual: boolean | null;
  score?: number;
  origins: Set<string>;
}

async function auditNeo4j(nodeIds: string[], claims: SeekClaim[]): Promise<{ nodes: number; rels: number; live: number }> {
  // every node id must be a :Person — id-scoped, never a global count (legacy population lives here too)
  let nodesSeen = 0;
  for (const batch of chunk(nodeIds, BATCH)) {
    const res = await run(`MATCH (p:Person) WHERE p.id IN $ids RETURN p.id AS id`, { ids: batch });
    const found = new Set(res.records.map((r) => String(r.get("id"))));
    nodesSeen += found.size;
    for (const id of batch) {
      if (!found.has(id)) add(rel(GRAPH_PATH), "person-node-missing", `node "${id}" has no :Person in Neo4j`);
    }
  }

  // every seek claim must be a SEEKS rel with a matching mutual flag
  let relsSeen = 0;
  for (const batch of chunk(claims, BATCH)) {
    const pairs = batch.map((c) => ({ s: c.s, t: c.t }));
    const res = await run(
      `
      UNWIND $pairs AS pr
      OPTIONAL MATCH (a:Person {id: pr.s})-[r:SEEKS]->(b:Person {id: pr.t})
      RETURN pr.s AS s, pr.t AS t, r IS NOT NULL AS present,
             r.mutual AS mutual, r.score AS score
      `,
      { pairs },
    );
    const got = new Map<string, { present: boolean; mutual: unknown; score: unknown }>();
    for (const r of res.records) {
      got.set(pairKey(String(r.get("s")), String(r.get("t"))), {
        present: Boolean(r.get("present")),
        mutual: r.get("mutual"),
        score: r.get("score"),
      });
    }
    for (const c of batch) {
      const where = [...c.origins][0] ?? rel(GRAPH_PATH);
      const hit = got.get(pairKey(c.s, c.t));
      if (!hit || !hit.present) {
        add(where, "seek-rel-missing", `no (:Person {id:"${c.s}"})-[:SEEKS]->(:Person {id:"${c.t}"}) in Neo4j`);
        continue;
      }
      relsSeen++;
      if (c.expectMutual !== null && Boolean(hit.mutual) !== c.expectMutual) {
        add(where, "seek-mutual-mismatch", `${c.s}->${c.t}: artifact says mutual=${c.expectMutual}, Neo4j says ${Boolean(hit.mutual)}`);
      }
      if (c.score !== undefined && hit.score != null) {
        const live = toNum(hit.score);
        if (Math.abs(live - c.score) > SCORE_EPS) {
          add(where, "seek-score-mismatch", `${c.s}->${c.t}: artifact score ${c.score}, Neo4j ${live}`);
        }
      }
    }
  }
  // I3 — the OTHER direction: a SEEKS rel the artifact omitted would make every recount
  // derived from graph.json (sought-by, mutual) consistently wrong and pass unnoticed.
  // $ids-scoped on BOTH endpoints so the legacy population is never in view.
  const artifactPairs = new Set(claims.map((c) => pairKey(c.s, c.t)));
  const live = new Set<string>();
  const liveMutual = new Set<string>();
  for (const batch of chunk(nodeIds, BATCH)) {
    const res = await run(
      `
      MATCH (a:Person)-[r:SEEKS]->(b:Person)
      WHERE a.id IN $from AND b.id IN $all
      RETURN a.id AS s, b.id AS t, r.mutual AS mutual
      `,
      { from: batch, all: nodeIds },
    );
    for (const r of res.records) {
      const k = pairKey(String(r.get("s")), String(r.get("t")));
      live.add(k);
      if (Boolean(r.get("mutual"))) liveMutual.add(k);
    }
  }
  const omitted = [...live].filter((k) => !artifactPairs.has(k));
  if (omitted.length > 0) {
    add(
      rel(GRAPH_PATH),
      "seek-edge-omitted",
      `Neo4j holds ${omitted.length} SEEKS rel(s) between audited people that no artifact claims — every graph.json recount (sought-by, mutual) is derived from the artifact set, so an omission passes silently: ${omitted.slice(0, 3).join(", ")}${omitted.length > 3 ? ", …" : ""}`,
    );
  }
  const liveMutualCount = liveMutual.size;
  const artifactMutual = claims.filter((c) => c.expectMutual === true).length;
  if (liveMutualCount !== artifactMutual) {
    add(rel(GRAPH_PATH), "seek-edge-omitted", `Neo4j holds ${liveMutualCount} mutual SEEKS rel(s) in scope, the artifacts claim ${artifactMutual}`);
  }

  return { nodes: nodesSeen, rels: relsSeen, live: live.size };
}

/* ─────────────────────────────── main ───────────────────────────── */

function report(notes: string[], summary: string): never {
  if (violations.length === 0) {
    for (const n of notes) console.log(`[audit] note: ${n}`);
    console.log(summary);
    process.exit(0);
  }
  const byFile = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = byFile.get(v.file) ?? [];
    list.push(v);
    byFile.set(v.file, list);
  }
  console.error(`\nFAIL: ${violations.length} violation(s) across ${byFile.size} file(s)\n`);
  for (const [file, list] of [...byFile.entries()].sort()) {
    console.error(`  ${file}  (${list.length})`);
    for (const v of list.slice(0, 10)) console.error(`    [${v.code}] ${v.detail}`);
    if (list.length > 10) console.error(`    … and ${list.length - 10} more in this file`);
  }
  const codes = new Map<string, number>();
  for (const v of violations) codes.set(v.code, (codes.get(v.code) ?? 0) + 1);
  console.error(
    `\n  by code: ${[...codes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(" ")}`,
  );
  for (const n of notes) console.error(`  note: ${n}`);
  console.error(`\n${summary}`);
  process.exit(1);
}

async function main(): Promise<void> {
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
  } catch {
    /* no .env — the preflight below names whatever is actually missing */
  }

  /* preflight: DEGRADED decisions are made up front, never mid-audit */
  const csvPath = process.env.GUESTS_CSV?.trim();
  if (!csvPath) degraded("GuestsCsvMissing", "GUESTS_CSV is not set — the audit re-derives everything from the CSV");
  if (!existsSync(csvPath)) degraded("GuestsCsvMissing", `no CSV at ${csvPath}`);
  let guests: Guest[];
  try {
    guests = loadGuests(csvPath);
  } catch (e) {
    degraded("GuestsCsvMissing", `loadGuests failed: ${(e as Error).message}`);
  }
  if (guests.length === 0) degraded("GuestsCsvMissing", `${csvPath} yielded 0 approved guests`);

  if (SKIP_NEO4J) {
    console.error("################################################################");
    console.error("#  SKIP_NEO4J=1 — GRAPH-INTEGRITY PHASE SKIPPED                #");
    console.error("#  This run does NOT prove that seek edges exist in Neo4j,     #");
    console.error("#  nor that every node id is a real :Person. OFFLINE DEV ONLY. #");
    console.error("################################################################");
  } else if (!isConfigured()) {
    const missing = ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"].filter((k) => !process.env[k]);
    degraded("Neo4jNotConfigured", `missing env [${missing.join(", ")}] — set them or run with SKIP_NEO4J=1 (partial audit)`);
  }

  console.log(`[audit] dir=${rel(AUDIT_DIR)} csv=${path.basename(csvPath)} population=${guests.length}`);

  const art = await loadArtifacts();
  if (!art) {
    report([], `audit FAILED: artifacts under ${rel(AUDIT_DIR)} are missing or unparseable`);
  }

  const priv = loadPrivate();
  const byId = new Map(guests.map((g) => [g.personId, g]));
  const nodeById = new Map(art.graph.nodes.map((n) => [n.id, n]));
  const stages = await csvStages(csvPath);

  auditPopulation(art.graph, guests, byId, art.people.map((p) => p.file));
  const notes = [...priv.notes, ...auditMeta(art.graph, guests, stages)];
  if (art.badFiles > 0) notes.push(`${art.badFiles} person file(s) failed to parse and were not audited further`);

  const d = derive(art.graph, guests);

  /* graph.json's own seek edges become claims against Neo4j */
  const claims = new Map<string, SeekClaim>();
  const claim = (s: string, t: string, expectMutual: boolean | null, origin: string, score?: number): void => {
    const k = pairKey(s, t);
    const prev = claims.get(k);
    if (!prev) {
      claims.set(k, { s, t, expectMutual, score, origins: new Set([origin]) });
      return;
    }
    prev.origins.add(origin);
    if (score !== undefined && prev.score === undefined) prev.score = score;
    if (expectMutual === null) return;
    if (prev.expectMutual === null) prev.expectMutual = expectMutual;
    else if (prev.expectMutual !== expectMutual) {
      add(origin, "mutual-flag-conflict", `${s}->${t}: artifacts disagree on mutual (${prev.expectMutual} vs ${expectMutual})`);
    }
  };
  for (const e of art.graph.edges) {
    if (e.type !== "seek") continue;
    claim(e.s, e.t, e.m === true, rel(GRAPH_PATH), e.score);
    // A mutual pair implies the reverse rel exists — but the reverse SEEKS carries its OWN
    // asymmetric cosine, so the forward score must NOT travel with the synthesized claim.
    // (If the emitter also writes the reverse edge explicitly, that edge supplies the score.)
    if (e.m === true) claim(e.t, e.s, true, rel(GRAPH_PATH), undefined);
  }

  /* obligations 1–3 + 5, per person */
  auditPii(rel(GRAPH_PATH), art.graphRaw);
  auditBareAt(rel(GRAPH_PATH), [["graph.json", art.graphRaw]]); // no answer text lives here
  let receipts = 0;
  let counts = 0;
  const seenIds = new Set<string>();
  for (const p of art.people) {
    if (seenIds.has(p.rec.personId)) add(p.file, "duplicate-person-record", `personId "${p.rec.personId}" already emitted`);
    seenIds.add(p.rec.personId);
    auditPii(p.file, p.raw);
    auditBareAt(p.file, nonAnswerText(p.rec));
    const res = auditPerson(p.file, p.rec, byId, nodeById, d, art.graph.nodes.length, stages?.raw ?? new Map(), priv.doppels, priv.openSeekers);
    receipts += res.receipts;
    counts += res.counts;
    for (const sp of res.seekPairs) claim(sp.s, sp.t, sp.expectMutual, sp.origin);
  }
  for (const g of guests) {
    if (!seenIds.has(g.personId)) add(rel(PEOPLE_DIR), "person-record-missing", `no record for ${g.personId}`);
  }

  /* obligation 4 */
  let live = { nodes: 0, rels: 0, live: 0 };
  if (!SKIP_NEO4J) {
    try {
      live = await auditNeo4j(
        art.graph.nodes.map((n) => n.id),
        [...claims.values()],
      );
    } catch (e) {
      if (e instanceof Neo4jNotConfigured) degraded("Neo4jNotConfigured", e.message);
      add(rel(GRAPH_PATH), "neo4j-unreachable", `graph-integrity phase failed: ${(e as Error).message}`);
    } finally {
      await close();
    }
  }

  const scope = SKIP_NEO4J
    ? "NEO4J PHASE SKIPPED (partial audit)"
    : `${live.rels}/${claims.size} seek rels + ${live.nodes} :Person nodes verified live, ${live.live} live rels reconciled both ways`;
  const summary =
    violations.length === 0
      ? `audit OK: ${art.graph.nodes.length} nodes · ${art.people.length} records · ${art.graph.edges.length} edges · ${receipts} receipts resolved (100%) · ${counts} counts re-derived · 0 violations · ${scope}`
      : `audit FAILED: ${violations.length} violation(s) · ${art.people.length} records · ${receipts - violations.filter((v) => v.code === "receipt-quote-not-verbatim").length}/${receipts} receipts verbatim · ${counts} counts re-derived · ${scope}`;

  report(notes, summary);
}

main().catch(async (e) => {
  await close().catch(() => undefined);
  if (e instanceof Neo4jNotConfigured) {
    console.error(`\nDEGRADED — ${e.name}: ${e.message}`);
    process.exit(2);
  }
  console.error(`\n[audit] FAILED with an unhandled error: ${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
