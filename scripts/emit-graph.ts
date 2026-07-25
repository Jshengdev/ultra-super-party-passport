/**
 * scripts/emit-graph.ts — bake the party into the two artifacts the /graph room serves:
 *
 *   public/graph/graph.json          nodes + edges + per-lens positions + meta
 *   public/graph/people/<id>.json    one record per guest: their own words, their ranked
 *                                    connections with receipts, and their highlights
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
 *   GUESTS_CSV   (required) the Luma guest export — answers, raw cells and guest_ids
 *   FIXTURE=1    (optional) OFFLINE FALLBACK: skip Neo4j and derive the structural edges
 *                from the CSV groupings instead. Same sampling, same output shape; the
 *                artifact records `meta.source: "fixture-csv"` so nobody can mistake a
 *                fixture bake for a graph bake.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { z } from "zod";
import { loadGuests, type Guest } from "../lib/guests";
import { isConfigured, run, toNum, close, Neo4jNotConfigured } from "../lib/neo4j";
import { webLayout, ringLayout, type Vec2 } from "../lib/layout";
import { vectorProvider } from "../lib/matches";

/* ────────────────────────────── inputs + shapes ────────────────────────────── */

const OUT_DIR = "public/graph";
const PEOPLE_DIR = join(OUT_DIR, "people");
const CONVICTIONS = "data/graph-private/convictions.json";
const MATCHES = "data/graph-private/matches.json";

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
  const guests = loadGuests(csvPath);
  const byGuestId = new Map(guests.map((g) => [g.personId, g] as const));
  const ids = guests.map((g) => g.personId);

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
  const nodes = people.map((p) => {
    const c = convOf(p.id);
    const g = byGuestId.get(p.id);
    return {
      id: p.id,
      name: p.name,
      title: p.title,
      school: p.school,
      company: p.company,
      free: Boolean(g?.isFreelance), // a CSV-side fact: the ontology has no "freelance" node
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
            ...withReceipt(convictionQuote(me.id), convictionQuote(other)),
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
      })}\n`,
    );
    records += 1;
  }

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
