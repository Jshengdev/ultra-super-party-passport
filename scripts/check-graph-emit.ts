/**
 * scripts/check-graph-emit.ts — the G-emit gate for the baked party artifacts.
 *
 * Reads ONLY what shipped — `public/graph/**` plus the two COMMITTED sheet files
 * (`data/graph-enriched.csv`, `data/graph-overrides.csv`) — never the private inputs,
 * because the question this answers is "is the thing we are about to serve safe and honest?".
 *
 * It FAILS (exit 1) on:
 *   · the wrong population (nodes / person files !== the emitted people count, or !== 312)
 *   · PII in any emitted byte (email · gmail · .edu · phone · luma.com; a bare "@" is
 *     forbidden outright in graph.json and allowed in a person record ONLY as a social
 *     handle mention inside the guest's own answer text — reported, never silent)
 *   · graph.json over 900KB
 *   · the dignity floor: any record with 0 edges or <3 highlights
 *   · a receipt quote on an ANSWER field that is not a verbatim substring of that
 *     record's own answers (school/company receipts quote raw CSV cells — Task 7's
 *     audit checks those against the CSV)
 *   · a person record's `conviction` block that carries a tag outside the CLOSED
 *     vocabularies, disagrees with that person's node in graph.json, quotes anything that
 *     is not byte-verbatim in the answer field the tag is read from, or still carries a
 *     quote behind a tag a human overrode (`_overridden`) — the old quote stopped being
 *     evidence when the tag moved, and a receipt for a claim nobody made is a fabrication
 *   · a person record's `inferred` block (registers 2+3 — OUR read, OUR labels) whose keys
 *     are not the pinned set, whose `mission`/`impact` is outside the CLOSED vocabularies,
 *     whose confidence is outside 0..1, whose `_src`/`_model` provenance is missing, or —
 *     the one that matters most — whose evidence quotes are not byte-verbatim in THAT
 *     record's own answers. We are allowed to guess about a guest; we are not allowed to
 *     invent the words we based the guess on. Absent is always legal (the block is an
 *     OPTIONAL emit input), so this gate is green on an offline bake that ships none.
 *   · graph.json's top-level `places`: a place whose `n` disagrees with its own `personIds`,
 *     a member who is not an emitted node, a member whose node names a different metro, a
 *     duplicated name or member, half a coordinate (lat without lng), a coordinate off the
 *     globe, or a population that does not add up to the nodes carrying a metro. Counts that
 *     are consistent by construction are still checked, because "by construction" is a claim
 *     about code and this gate reads only what shipped.
 *   · a person record's `taste` block (THE FOURTH BLOCK — two guests who wrote the same
 *     answer): a key outside {favorite, inspiration}, a `verbatim` that is not byte-literal in
 *     that record's own answer, a twin who is not in the graph, a twin whose quote is not
 *     byte-literal in THEIR record's answer, or a claim that is not symmetric — if A is B's
 *     twin on a field and B is not A's, one of the two records is lying about the other.
 *   · a `direction` outside the contract enum, an edge pointing at nobody, a
 *     zero-count fact rendered as text, or an internal `flags` value leaking into copy
 *   · meta.stages / meta.guestIds missing (the entry drop-zone reads both)
 *   · meta.matchProvider missing or outside {gateway, tfidf} (the artifact must name which
 *     vector provider produced the SEEKS matches, not just the DB's per-rel `_src`)
 *   · the enrichment sheet (`data/graph-enriched.csv`): absent, a header that is not EXACTLY
 *     the pinned column list, a row count that disagrees with the node count, or contact PII
 *     of any shape — including wallet addresses, which no other tripwire in this repo covers
 *   · the overrides sheet (`data/graph-overrides.csv`): a person_id that resolves to nobody
 *     (a hidden person is the one legitimate absence), or a tag outside the CLOSED conviction
 *     vocabularies. An override nobody can bind is an edit that silently did nothing.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import Papa from "papaparse";
import { MOTIVES, MISSIONS, IMPACTS, ASPIRATIONS } from "../lib/conviction";

const GRAPH = "public/graph/graph.json";
const PEOPLE_DIR = "public/graph/people";
const SHEET = "data/graph-enriched.csv";
/** SAME resolution the emitter uses, so the gate always inspects the file that produced the artifacts. */
const OVERRIDES = process.env.OVERRIDES_PATH?.trim() || "data/graph-overrides.csv";

/**
 * The pinned sheet contract, re-declared here on purpose (same reasoning as
 * scripts/audit-graph.ts's TAG_PHRASE table): a gate that imports the subject's own constant
 * proves only that the subject agrees with itself. If emit-graph.ts moves a column, this
 * fails loudly instead of silently ratifying the move.
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
];
/**
 * The same contract before `metro` joined it. A sheet baked by an earlier emit is a LEGAL
 * artifact — this gate reads what shipped, and what shipped was correct when it shipped — so
 * the pre-metro header passes with a NOTE rather than a failure. Anything that is neither list
 * still fails loudly. (Derived from the list above rather than copied, so the two can never
 * drift into disagreeing about the other 36 columns.)
 */
const SHEET_COLUMNS_PRE_METRO = SHEET_COLUMNS.filter((c) => c !== "metro");
const OVERRIDE_COLUMNS = [
  "person_id", "motive", "mission", "impact", "aspiration", "pinned_match", "hide", "host_notes",
];
/** The four closed conviction vocabularies — checked in the overrides sheet AND, since the
 *  person records carry a `conviction` block, where the tags actually SHIP. */
const TAG_VOCAB: Record<string, readonly string[]> = {
  motive: MOTIVES,
  mission: MISSIONS,
  impact: IMPACTS,
  aspiration: ASPIRATIONS,
};
/**
 * tag -> the answer field its receipt must be verbatim from. Re-declared here on purpose (same
 * reasoning as SHEET_COLUMNS): emit-graph.ts's TAG_QUOTE_FIELD is the subject under test, and a
 * gate that imports the subject's own table proves only that the subject agrees with itself.
 * `aspiration` reads off `goal` like the others but ships no quote — the emitter's QUOTED_TAGS.
 */
const TAG_QUOTE_FIELD: Record<string, string> = { motive: "drew", mission: "goal", impact: "goal" };
/** the graph.json node field each conviction tag must equal — same bake, one truth */
const TAG_NODE_FIELD: Record<string, "motive" | "mission" | "impact" | "asp"> = {
  motive: "motive",
  mission: "mission",
  impact: "impact",
  aspiration: "asp",
};

const fail = (m: string) => {
  console.error("FAIL:", m);
  process.exit(1);
};

/**
 * Green-with-a-note. Every block this gate checks is an OPTIONAL emit output, so an artifact
 * baked before that block existed is legal and must pass — but it must never pass SILENTLY,
 * or "the check is green" and "the check ran" become the same sentence.
 */
const notes: string[] = [];

interface GNode {
  id: string;
  name: string;
  title: string;
  school: string | null;
  company: string | null;
  free: boolean;
  hometown?: string | null;
  metro?: string | null;
  motive: string | null;
  mission: string | null;
  impact: string | null;
  asp: string | null;
  deg: number;
  pos: { web: [number, number]; why: [number, number]; seek: [number, number] };
}
interface GEdge {
  s: string;
  t: string;
  type: string;
  via: string;
  m?: boolean;
  score?: number;
}
/** parsed as `unknown` where it is checked — this gate types nothing it has not verified */
interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  places?: unknown;
  meta: {
    people: number;
    built: string;
    counts: Record<string, number>;
    stages: Record<string, number>;
    guestIds: string[];
    matchProvider?: string;
    placeCoords?: Record<string, unknown>;
  };
}
interface PersonEdge {
  targetId: string;
  type: string;
  direction?: string;
  strength?: number;
  via: string;
  receipt?: { yours?: { field: string; quote: string }; theirs?: { field: string; quote: string } };
}
interface PersonRecord {
  personId: string;
  name: string;
  answers: Record<string, string>;
  edges: PersonEdge[];
  highlights: { kind: string; text: string; targets?: string[] }[];
  /** the computed identity, post-override — every key optional, the whole block omitted
      when the extraction had nothing to say (parsed as unknown: this gate types nothing
      it has not checked) */
  conviction?: Record<string, unknown>;
  /** registers 2+3 — OUR read + OUR labels, a SIBLING of `conviction` (parsed as unknown too) */
  inferred?: Record<string, unknown>;
  /** the fourth block — two guests who wrote the same answer (unknown until checked) */
  taste?: Record<string, unknown>;
  _overridden?: string[];
}

/**
 * The pinned key set of the `inferred` block. A key outside it is a register nobody declared —
 * the whole value of the third register is that a consumer knows exactly what it is looking at.
 */
const INFERRED_KEYS = new Set(["summary", "mission", "impact", "_src", "_model"]);
/** The answer fields an inferred evidence span may cite (the four the summary pass is shown). */
const INFERRED_EVIDENCE_FIELDS = new Set(["goal", "drew", "seeking", "inspiration"]);
/** The two answer fields a taste twin may be drawn from — the keys of the `taste` block. */
const TASTE_FIELDS = ["favorite", "inspiration"] as const;

const EXPECTED_PEOPLE = 312;
const EDGE_TYPES = new Set(["school", "company", "why", "seek"]);
const DIRECTIONS = new Set(["mutual", "inbound", "outbound"]);
const ANSWER_FIELDS = new Set(["goal", "drew", "seeking", "inspiration", "favorite"]);

/** contact-shaped PII — forbidden in every emitted byte, no exceptions */
const CONTACT_PII: [string, RegExp][] = [
  ["email", /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
  ["gmail", /\bgmail\b/i],
  [".edu", /\.edu\b/i],
  ["phone", /\+?1?[-. (]?\d{3}[-. )]?\d{3}[-. ]?\d{4}\b/],
  ["luma.com", /luma\.com/i],
];
/** a social handle someone typed INSIDE their own answer: "@guywithamoviecamera" */
const HANDLE = /@[A-Za-z0-9._]{1,30}/g;

if (!existsSync(GRAPH)) fail(`${GRAPH} does not exist — run scripts/emit-graph.ts first`);
if (!existsSync(PEOPLE_DIR)) fail(`${PEOPLE_DIR}/ does not exist — run scripts/emit-graph.ts first`);

const raw = readFileSync(GRAPH, "utf8");
const g = JSON.parse(raw) as Graph;

if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) fail("graph.json is missing nodes/edges");
if (g.nodes.length !== EXPECTED_PEOPLE) fail(`nodes ${g.nodes.length} !== ${EXPECTED_PEOPLE}`);
if (g.meta?.people !== g.nodes.length) fail(`meta.people ${g.meta?.people} !== nodes ${g.nodes.length}`);

for (const [label, re] of CONTACT_PII) if (re.test(raw)) fail(`PII tripwire hit in graph.json: ${label}`);
if (/@/.test(raw)) fail("PII tripwire hit in graph.json: bare @");
if (raw.length > 900_000) fail(`graph.json too big: ${raw.length}`);

/* ---- node shape + per-lens positions ---- */
const ids = new Set<string>();
let hometowns = 0;
let metros = 0;
const metroOfNode = new Map<string, string>();
for (const n of g.nodes) {
  if (!n.id || ids.has(n.id)) fail(`bad or duplicate node id: ${n.id}`);
  ids.add(n.id);
  if (typeof n.name !== "string" || n.name.length === 0) fail(`node ${n.id} has no name`);
  if (typeof n.deg !== "number") fail(`node ${n.id} has no deg`);
  /* the room prints this one on a stamp, so it is shape-checked here as well as
     byte-for-byte in audit-graph — that audit needs Neo4j, and a DEGRADED run must
     still catch a hometown that arrives as a number, an object, or an empty string
     pretending to be an answer. (The contact-PII + bare-"@" tripwires above scan the
     whole blob, so this field inherits them.) */
  if ("hometown" in n && n.hometown !== null && n.hometown !== undefined) {
    if (typeof n.hometown !== "string" || n.hometown.trim().length === 0) {
      fail(`node ${n.id} has a non-string or empty hometown: ${JSON.stringify(n.hometown)}`);
    }
    hometowns += 1;
  }
  /* the derived metro, and the rule that makes it answerable: it never ships without the cell
     it was derived from. A metro with no hometown beside it is a place claim with no receipt. */
  if ("metro" in n && n.metro !== null && n.metro !== undefined) {
    if (typeof n.metro !== "string" || n.metro.trim().length === 0) {
      fail(`node ${n.id} has a non-string or empty metro: ${JSON.stringify(n.metro)}`);
    }
    if (n.hometown === null || n.hometown === undefined) {
      fail(`node ${n.id} carries metro "${n.metro}" but no hometown — the cell is the metro's receipt`);
    }
    metroOfNode.set(n.id, n.metro);
    metros += 1;
  }
  for (const lens of ["web", "why", "seek"] as const) {
    const p = n.pos?.[lens];
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      fail(`node ${n.id} has no finite ${lens} position`);
    }
  }
}
/* 311 of 312 guests answered the hometown question. A bake that drops below this floor
   has lost the field somewhere between the CSV and the node — the stamps would go quiet
   for the whole room and nothing else would say why. */
const HOMETOWN_MIN = 300;
if (hometowns < HOMETOWN_MIN) {
  fail(`only ${hometowns} of ${g.nodes.length} nodes carry a hometown — below the ${HOMETOWN_MIN} floor`);
}
/* Either the whole bake normalizes hometowns or none of it does. A bake where some nodes
   carry a metro and others with a real hometown do not is one where the grouping silently
   under-counts — exactly the defect the metro table exists to remove. */
if (metros === 0) {
  notes.push("no node carries a metro — pre-D3 artifact, so the places checks below are inert");
} else if (metros !== hometowns) {
  fail(`${metros} of ${hometowns} nodes with a hometown carry a metro — a partly-normalized bake under-counts every cohort`);
}

/* ---- edges resolve, types are in the contract ---- */
const degree = new Map<string, number>();
for (const e of g.edges) {
  if (!EDGE_TYPES.has(e.type)) fail(`edge type "${e.type}" is outside the contract (${e.s}→${e.t})`);
  if (!ids.has(e.s) || !ids.has(e.t)) fail(`edge ${e.s}→${e.t} (${e.type}) points at a node that is not in the graph`);
  if (e.s === e.t) fail(`self edge on ${e.s} (${e.type})`);
  if (typeof e.via !== "string" || e.via.length === 0) fail(`edge ${e.s}→${e.t} (${e.type}) has no via`);
  degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
  degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
}
for (const n of g.nodes) {
  if (n.deg !== (degree.get(n.id) ?? 0)) fail(`node ${n.id} deg ${n.deg} !== its ${degree.get(n.id) ?? 0} edges`);
}

/* ---- meta the entry drop-zone reads ---- */
const STAGE_KEYS = [
  "rows",
  "approved",
  "unique",
  "schools",
  "companies",
  "convictions",
  "seekEdges",
  "mutuals",
  "whyEdges",
];
for (const k of STAGE_KEYS) {
  const v = g.meta?.stages?.[k];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`meta.stages.${k} is missing or not a number`);
}
if (!Array.isArray(g.meta?.guestIds)) fail("meta.guestIds is missing");
if (g.meta.guestIds.length !== g.nodes.length) {
  fail(`meta.guestIds ${g.meta.guestIds.length} !== nodes ${g.nodes.length}`);
}
if (new Set(g.meta.guestIds).size !== g.meta.guestIds.length) fail("meta.guestIds contains duplicates");
if (g.meta.stages.unique !== g.nodes.length) fail(`meta.stages.unique ${g.meta.stages.unique} !== nodes ${g.nodes.length}`);

// the artifact must name which vector provider produced the SEEKS matches (law d: the
// committed artifact is self-describing, not just the DB's `_src` on the SEEKS rels)
const MATCH_PROVIDERS = new Set(["gateway", "tfidf"]);
if (!MATCH_PROVIDERS.has(g.meta?.matchProvider ?? "")) {
  fail(`meta.matchProvider "${g.meta?.matchProvider}" is missing or outside {gateway, tfidf}`);
}

/* ---- the places array: one entry per metro in the room, counts consistent with the nodes ----
 * OPTIONAL (a pre-D3 artifact has none), and everything present is held to the rule that makes
 * a count trustworthy: the number and the membership must be the same fact twice. */
let placeCount = 0;
let placeCoordCount = 0;
let placePeople = 0;
if (g.places === undefined) {
  notes.push("graph.json carries no places array — pre-D3 artifact, legal, and the next bake adds it");
} else {
  if (!Array.isArray(g.places)) fail("graph.json places is not an array");
  const seenPlace = new Set<string>();
  const claimed = new Set<string>();
  for (const [i, raw] of (g.places as unknown[]).entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`places[${i}] is not an object`);
    const p = raw as Record<string, unknown>;
    const where = `places[${i}] (${JSON.stringify(p.name)})`;
    if (typeof p.name !== "string" || p.name.trim().length === 0) fail(`${where} has no name`);
    if (seenPlace.has(p.name as string)) fail(`${where}: duplicate place name — one entry per metro`);
    seenPlace.add(p.name as string);

    if (!Array.isArray(p.personIds) || p.personIds.length === 0) fail(`${where} has no personIds`);
    const members = p.personIds as unknown[];
    const local = new Set<string>();
    for (const m of members) {
      if (typeof m !== "string" || !ids.has(m)) fail(`${where} lists "${String(m)}", who is not a node in graph.json`);
      if (local.has(m as string)) fail(`${where} lists ${m} twice`);
      local.add(m as string);
      if (claimed.has(m as string)) fail(`${where} claims ${m}, who is already in another place — one metro per person`);
      claimed.add(m as string);
      // the node and the place must be the same bake's answer, not two opinions
      const onNode = metroOfNode.get(m as string);
      if (metros > 0 && onNode !== p.name) {
        fail(`${where} claims ${m}, whose node says metro ${JSON.stringify(onNode ?? null)}`);
      }
    }
    if (p.n !== members.length) fail(`${where}: n ${String(p.n)} !== its ${members.length} personIds`);

    // half a coordinate is worse than none: it renders as a pin at longitude zero
    const hasLat = p.lat !== undefined;
    const hasLng = p.lng !== undefined;
    if (hasLat !== hasLng) fail(`${where} carries ${hasLat ? "lat without lng" : "lng without lat"}`);
    if (hasLat) {
      const { lat, lng } = p as { lat: unknown; lng: unknown };
      if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) fail(`${where} lat ${String(lat)} is off the globe`);
      if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) fail(`${where} lng ${String(lng)} is off the globe`);
      if (lat === 0 && lng === 0) fail(`${where} sits at 0,0 — that is the Gulf of Guinea, not an unknown place; omit the coordinate instead`);
      placeCoordCount += 1;
    }
    placeCount += 1;
    placePeople += members.length;
  }
  // nobody with a metro may be missing from the array, or a cohort is quietly short
  if (placePeople !== metros) fail(`places account for ${placePeople} people but ${metros} nodes carry a metro`);
  for (const [id, m] of metroOfNode) {
    if (!claimed.has(id)) fail(`node ${id} carries metro "${m}" but appears in no place`);
  }

  // the coordinate provenance: world knowledge, and the artifact says so (law d)
  const pc = g.meta?.placeCoords;
  if (pc === undefined) {
    notes.push("graph.json carries places but no meta.placeCoords — the coordinates ship unattributed");
  } else {
    if (typeof pc._src !== "string" || pc._src.trim().length === 0) {
      fail("meta.placeCoords._src is missing — vendored coordinates are not guest data and must say where they came from");
    }
    if (pc.metros !== placeCount) fail(`meta.placeCoords.metros ${String(pc.metros)} !== ${placeCount} places`);
    if (pc.coordinated !== placeCoordCount) fail(`meta.placeCoords.coordinated ${String(pc.coordinated)} !== ${placeCoordCount} places with a coordinate`);
    if (typeof pc.placeable !== "number" || pc.placeable > placePeople) {
      fail(`meta.placeCoords.placeable ${String(pc.placeable)} is not a number of people ≤ ${placePeople}`);
    }
  }
}

/* ---- the person records ---- */
const files = readdirSync(PEOPLE_DIR).filter((f) => f.endsWith(".json"));
if (files.length !== EXPECTED_PEOPLE) fail(`people files ${files.length} !== ${EXPECTED_PEOPLE}`);

const nodeById = new Map(g.nodes.map((n) => [n.id, n] as const));
let convictionBlocks = 0;
let convictionReceipts = 0;
let inferredBlocks = 0;
let inferredMissions = 0;
let inferredImpacts = 0;
let inferredSpans = 0;
let inferredMinConfidence = Infinity;
let edgeTotal = 0;
let highlightTotal = 0;
let minEdges = Infinity;
let minHighlights = Infinity;
let handleMentions = 0;
let numericClaims = 0;
const handleSamples: string[] = [];
const seenIds = new Set<string>();
/** every record's own answers, so a taste twin's quote can be checked against THEIR record */
const answersById = new Map<string, Record<string, string>>();
/** `${personId}|${field}|${twinId}` -> the quote this record attributes to that twin */
const tasteClaims = new Map<string, string>();
let tasteBlocks = 0;
let tasteTwinQuotes = 0;

for (const f of files) {
  const body = readFileSync(`${PEOPLE_DIR}/${f}`, "utf8");
  const p = JSON.parse(body) as PersonRecord;

  if (`${p.personId}.json` !== f) fail(`${f} carries personId "${p.personId}"`);
  if (!ids.has(p.personId)) fail(`${f} is not a node in graph.json`);
  if (seenIds.has(p.personId)) fail(`duplicate person record ${f}`);
  seenIds.add(p.personId);

  /* PII: contact shapes never, a handle mention only inside an answer. Both scans read the whole
     file body, so every block a record grows — `conviction`, `inferred`, whatever comes next — is
     covered the day it is added, with no pattern list to keep in step. */
  for (const [label, re] of CONTACT_PII) if (re.test(body)) fail(`PII tripwire hit in ${f}: ${label}`);
  const answersBlob = Object.values(p.answers ?? {}).join(" ");
  for (const m of body.matchAll(HANDLE)) {
    if (!answersBlob.includes(m[0])) fail(`PII tripwire hit in ${f}: "@" outside the guest's own answers (${m[0]})`);
    handleMentions += 1;
    if (handleSamples.length < 4) handleSamples.push(`${f}: ${m[0]}`);
  }

  /* dignity floor */
  if (!p.edges?.length) fail(`dignity floor: ${f} has 0 edges`);
  if ((p.highlights?.length ?? 0) < 3) fail(`dignity floor: ${f} has <3 highlights`);
  edgeTotal += p.edges.length;
  highlightTotal += p.highlights.length;
  minEdges = Math.min(minEdges, p.edges.length);
  minHighlights = Math.min(minHighlights, p.highlights.length);

  for (const e of p.edges) {
    if (!EDGE_TYPES.has(e.type)) fail(`${f}: edge type "${e.type}" is outside the contract`);
    if (!ids.has(e.targetId)) fail(`${f}: edge points at "${e.targetId}", who is not in the graph`);
    if (e.targetId === p.personId) fail(`${f}: edge points at itself`);
    if (e.direction !== undefined && !DIRECTIONS.has(e.direction)) {
      fail(`${f}: direction "${e.direction}" is outside {mutual, inbound, outbound}`);
    }
    if (e.type === "seek" && e.direction === undefined) fail(`${f}: seek edge to ${e.targetId} has no direction`);
    // receipts on ANSWER fields must be the guest's own words, byte for byte
    for (const side of ["yours", "theirs"] as const) {
      const r = e.receipt?.[side];
      if (!r) continue;
      if (typeof r.field !== "string" || typeof r.quote !== "string" || r.quote.length === 0) {
        fail(`${f}: malformed ${side} receipt on the ${e.type} edge to ${e.targetId}`);
      }
      if (side === "yours" && ANSWER_FIELDS.has(r.field) && !(p.answers?.[r.field] ?? "").includes(r.quote)) {
        fail(`receipt quote not verbatim in ${f} (field ${r.field})`);
      }
    }
  }

  /* copy hygiene: no zero-counts, no internal flags in anything a guest reads.
   * Every integer in every template is checked, not the handful a pattern list would
   * anticipate: a count that reached the copy is a claim, and a claim of 0 is a bug.
   * "One of 1" is the same bug wearing a number — being the only one is its own fact,
   * with its own sentence, never a group of one. */
  for (const h of p.highlights) {
    if (typeof h.text !== "string" || h.text.trim().length === 0) fail(`${f}: highlight "${h.kind}" has no text`);
    for (const m of h.text.matchAll(/\d+/g)) {
      if (Number(m[0]) === 0) fail(`${f}: zero-count fact rendered — "${h.text}"`);
    }
    for (const m of h.text.matchAll(/\bone of (\d+)\b/gi)) {
      if (Number(m[1]) < 2) fail(`${f}: "one of ${m[1]}" is a zero-count in disguise — "${h.text}"`);
    }
    numericClaims += [...h.text.matchAll(/\d+/g)].length;
    if (/missing-(school|answers)|\bflags?\b/i.test(h.text)) fail(`${f}: internal flag leaked into copy — "${h.text}"`);
    for (const t of h.targets ?? []) if (!ids.has(t)) fail(`${f}: highlight "${h.kind}" targets ${t}, who is not in the graph`);
  }

  /* the conviction block: the computed "who we think you are", and the receipts under it.
   * A card renders this as a claim about a person, so all four of its ways of being wrong
   * are checked here: a tag no vocabulary contains, a tag that contradicts the same bake's
   * node, a quote that is not the guest's own bytes, and a quote still standing behind a tag
   * a human replaced (the override law drops it — an old receipt is not evidence for a new
   * claim). Absent is always legal; blank is not. */
  const conv = p.conviction;
  if (conv !== undefined) {
    if (conv === null || typeof conv !== "object" || Array.isArray(conv)) fail(`${f}: conviction is not an object`);
    if (Object.keys(conv).length === 0) fail(`${f}: conviction is present but empty — omit it instead`);
    convictionBlocks += 1;
    const node = nodeById.get(p.personId);
    const moved = new Set(p._overridden ?? []);
    const quotes = conv.quotes;

    for (const [tag, value] of Object.entries(conv)) {
      if (tag === "quotes") continue;
      const vocab = TAG_VOCAB[tag];
      if (!vocab) fail(`${f}: conviction carries "${tag}", which is not a conviction tag`);
      if (typeof value !== "string" || !vocab.includes(value)) {
        fail(`${f}: conviction.${tag} = ${JSON.stringify(value)} is outside the closed vocabulary (${vocab.length} allowed values)`);
      }
      const onNode = node?.[TAG_NODE_FIELD[tag]] ?? null;
      if (onNode !== value) fail(`${f}: conviction.${tag} "${value}" !== graph.json node's "${onNode}" — one bake, two answers`);
    }
    /* a tag on the node that never reached the record would render an empty card next to a
       populated room; the block is a copy of the node's tags, not a subset of them */
    for (const [tag, field] of Object.entries(TAG_NODE_FIELD)) {
      const onNode = node?.[field] ?? null;
      if (onNode !== null && conv[tag] === undefined) fail(`${f}: node carries ${tag} "${onNode}" but the conviction block dropped it`);
    }

    if (quotes !== undefined) {
      if (quotes === null || typeof quotes !== "object" || Array.isArray(quotes)) fail(`${f}: conviction.quotes is not an object`);
      const qs = quotes as Record<string, unknown>;
      if (Object.keys(qs).length === 0) fail(`${f}: conviction.quotes is present but empty — omit it instead`);
      for (const [tag, quote] of Object.entries(qs)) {
        const field = TAG_QUOTE_FIELD[tag];
        if (!field) fail(`${f}: conviction.quotes carries "${tag}" — receipts key on {motive, mission, impact}`);
        if (typeof quote !== "string" || quote.length === 0) fail(`${f}: conviction.quotes.${tag} is empty`);
        if (conv[tag] === undefined) fail(`${f}: conviction.quotes.${tag} is a receipt for a tag that is not there`);
        if (moved.has(tag)) {
          fail(`${f}: conviction.${tag} was overridden but still ships a quote — the old receipt is not evidence for the new tag`);
        }
        if (!(p.answers?.[field] ?? "").includes(quote as string)) {
          fail(`conviction quote not verbatim in ${f} (${tag} ← ${field})`);
        }
        convictionReceipts += 1;
      }
    }
  }

  /* the inferred block — registers 2 and 3, structurally segregated from everything the guest
   * actually said. (That segregation is already enforced from the other side: the conviction
   * loop above fails on any key that is not a conviction tag, so an `inferred` smuggled INSIDE
   * `conviction` cannot ship.) The block is an OPTIONAL emit input, so absent is legal and this
   * whole section is a no-op on a bake that had no summaries artifact — but everything that IS
   * present is held to the same bar as a conviction receipt: our guess may be wrong, the words
   * we base it on may not be. */
  const inf = p.inferred;
  if (inf !== undefined) {
    if (inf === null || typeof inf !== "object" || Array.isArray(inf)) fail(`${f}: inferred is not an object`);
    const keys = Object.keys(inf);
    const extra = keys.filter((k) => !INFERRED_KEYS.has(k));
    if (extra.length > 0) {
      fail(`${f}: inferred carries [${extra.join(", ")}] — the block's keys are pinned to {${[...INFERRED_KEYS].join(", ")}}`);
    }
    for (const k of ["_src", "_model"] as const) {
      const v = inf[k];
      if (typeof v !== "string" || v.trim().length === 0) {
        fail(`${f}: inferred.${k} is missing or empty — an unattributed read is not shippable (law d)`);
      }
    }
    if (!keys.some((k) => k === "summary" || k === "mission" || k === "impact")) {
      fail(`${f}: inferred carries provenance but no claim — omit the block instead`);
    }
    inferredBlocks += 1;

    /** One claim: its value, its confidence, and every span it stands on. */
    const checkClaim = (where: string, claim: unknown, vocab: readonly string[] | null): void => {
      if (claim === undefined) return;
      if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
        fail(`${f}: inferred.${where} is not an object`);
        return;
      }
      const c = claim as Record<string, unknown>;

      if (vocab === null) {
        if (typeof c.text !== "string" || c.text.trim().length === 0) fail(`${f}: inferred.${where}.text is missing or empty`);
      } else if (typeof c.value !== "string" || !vocab.includes(c.value)) {
        fail(`${f}: inferred.${where}.value = ${JSON.stringify(c.value)} is outside the closed vocabulary (${vocab.length} allowed values)`);
      }

      const conf = c.confidence;
      if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 0 || conf > 1) {
        fail(`${f}: inferred.${where}.confidence ${JSON.stringify(conf)} is not a number in 0..1`);
      } else {
        inferredMinConfidence = Math.min(inferredMinConfidence, conf);
      }

      // law c: every claim carries a receipt, and every receipt resolves in the guest's OWN words
      const ev = c.evidence;
      if (!Array.isArray(ev) || ev.length === 0) {
        fail(`${f}: inferred.${where} carries no evidence — a read with no receipt is not a read`);
        return;
      }
      for (const [i, item] of ev.entries()) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          fail(`${f}: inferred.${where}.evidence[${i}] is not an object`);
          continue;
        }
        const e = item as Record<string, unknown>;
        if (typeof e.field !== "string" || !INFERRED_EVIDENCE_FIELDS.has(e.field)) {
          fail(`${f}: inferred.${where}.evidence[${i}] cites "${String(e.field)}" — spans cite {${[...INFERRED_EVIDENCE_FIELDS].join(", ")}}`);
          continue;
        }
        if (typeof e.quote !== "string" || e.quote.length === 0) {
          fail(`${f}: inferred.${where}.evidence[${i}] has an empty quote`);
          continue;
        }
        // EXACT byte-literal containment against THIS record's own answers, zero normalization
        if (!(p.answers?.[e.field] ?? "").includes(e.quote)) {
          fail(`inferred evidence not verbatim in ${f} (${where} ← ${e.field})`);
        }
        inferredSpans += 1;
      }
    };

    checkClaim("summary", inf.summary, null);
    checkClaim("mission", inf.mission, TAG_VOCAB.mission);
    checkClaim("impact", inf.impact, TAG_VOCAB.impact);
    if (inf.mission !== undefined) inferredMissions += 1;
    if (inf.impact !== undefined) inferredImpacts += 1;
  }

  /* the taste block — the fourth block, and the only one whose receipt lives in SOMEONE ELSE's
   * record. This side checks everything a single file can settle; the cross-record half (does
   * that person's own answer really say that, and do they name us back) runs after the loop,
   * because it cannot be answered until every record is read. */
  answersById.set(p.personId, p.answers ?? {});
  const taste = p.taste;
  if (taste !== undefined) {
    if (taste === null || typeof taste !== "object" || Array.isArray(taste)) fail(`${f}: taste is not an object`);
    const keys = Object.keys(taste);
    if (keys.length === 0) fail(`${f}: taste is present but empty — omit it instead`);
    const extra = keys.filter((k) => !(TASTE_FIELDS as readonly string[]).includes(k));
    if (extra.length > 0) fail(`${f}: taste carries [${extra.join(", ")}] — the block's keys are pinned to {${TASTE_FIELDS.join(", ")}}`);
    tasteBlocks += 1;

    for (const field of TASTE_FIELDS) {
      const hit = taste[field];
      if (hit === undefined) continue;
      if (hit === null || typeof hit !== "object" || Array.isArray(hit)) fail(`${f}: taste.${field} is not an object`);
      const h = hit as Record<string, unknown>;
      if (typeof h.verbatim !== "string" || h.verbatim.length === 0) fail(`${f}: taste.${field}.verbatim is missing or empty`);
      // MY half of the receipt: byte-literal in my own answer, zero normalization
      if (!(p.answers?.[field] ?? "").includes(h.verbatim as string)) {
        fail(`taste quote not verbatim in ${f} (${field})`);
      }
      if (!Array.isArray(h.with) || h.with.length === 0) {
        fail(`${f}: taste.${field} names no twin — a match with nobody on the other side is not a match`);
      }
      const seenTwin = new Set<string>();
      for (const [i, item] of (h.with as unknown[]).entries()) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) fail(`${f}: taste.${field}.with[${i}] is not an object`);
        const w = item as Record<string, unknown>;
        if (typeof w.personId !== "string" || !ids.has(w.personId)) {
          fail(`${f}: taste.${field}.with[${i}] names "${String(w.personId)}", who is not in the graph`);
        }
        if (w.personId === p.personId) fail(`${f}: taste.${field} names the record's own subject as their twin`);
        if (seenTwin.has(w.personId as string)) fail(`${f}: taste.${field} names ${w.personId} twice`);
        seenTwin.add(w.personId as string);
        if (typeof w.quote !== "string" || w.quote.length === 0) fail(`${f}: taste.${field}.with[${i}] has an empty quote`);
        tasteClaims.set(`${p.personId}|${field}|${w.personId as string}`, w.quote as string);
        tasteTwinQuotes += 1;
      }
    }
  }
}

/* the cross-record half of the taste receipt. Two failures live here and nowhere else:
 *   · a quote attributed to a twin that is not in THEIR own answer — a fabricated receipt
 *     about a third party, the worst shape this artifact can take;
 *   · an asymmetric claim. Sharing an answer is symmetric by definition, so if A names B and
 *     B does not name A, one of the two records is wrong about the room. */
for (const [key, quote] of tasteClaims) {
  const [me, field, twin] = key.split("|");
  const theirAnswers = answersById.get(twin);
  if (!theirAnswers) fail(`${me}.json: taste.${field} names ${twin}, who has no person record`);
  if (!(theirAnswers?.[field] ?? "").includes(quote)) {
    fail(`taste twin quote not verbatim in ${twin}.json (cited by ${me}.json, field ${field})`);
  }
  if (!tasteClaims.has(`${twin}|${field}|${me}`)) {
    fail(`${me}.json: taste.${field} names ${twin} as a twin, but ${twin}.json does not name ${me} back`);
  }
}

/* The block is absent for the handful the extraction could say nothing about, and a receipt
   is legitimately dropped whenever a human moves a tag — so neither has a fixed count. What
   is NOT survivable is the block or its receipts quietly emptying out for the whole room
   (as baked 2026-07-25: 307 blocks, 276 receipts). Same reasoning as HOMETOWN_MIN. */
const CONVICTION_MIN = 300;
const RECEIPT_MIN = 200;
if (convictionBlocks < CONVICTION_MIN) {
  fail(`only ${convictionBlocks} of ${files.length} records carry a conviction block — below the ${CONVICTION_MIN} floor`);
}
if (convictionReceipts < RECEIPT_MIN) {
  fail(`only ${convictionReceipts} verbatim conviction receipts across ${files.length} records — below the ${RECEIPT_MIN} floor`);
}

/* ---- the enrichment sheet: the human-editable station between pipeline and artifacts ---- */
if (!existsSync(SHEET)) fail(`${SHEET} does not exist — run scripts/emit-graph.ts first`);
const sheetRaw = readFileSync(SHEET, "utf8");

/**
 * The sheet is a working document that gets opened in a spreadsheet, mailed around and
 * pasted into chat threads. Everything the artifacts are forbidden to carry, it is forbidden
 * to carry — plus wallet addresses, which are contact-shaped in exactly the way that matters
 * and which no other tripwire in this repo covers.
 */
const SHEET_PII: [string, RegExp][] = [
  ...CONTACT_PII,
  ["evm wallet", /\b0x[a-fA-F0-9]{40}\b/],
  ["btc wallet", /\bbc1[ac-hj-np-z02-9]{11,71}\b/],
  ["btc wallet", /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/],
];
for (const [label, re] of SHEET_PII) {
  const hit = re.exec(sheetRaw);
  if (hit) fail(`PII tripwire hit in ${SHEET}: ${label} at byte ${hit.index} — value withheld`);
}

const sheet = Papa.parse<Record<string, string>>(sheetRaw, { header: true, skipEmptyLines: true });
if (sheet.errors.length > 0) {
  fail(`${SHEET} is unparseable: row ${sheet.errors[0].row} — ${sheet.errors[0].message}`);
}
const sheetHeader = sheet.meta.fields ?? [];
const sheetPreMetro = sheetHeader.join(",") === SHEET_COLUMNS_PRE_METRO.join(",");
if (sheetPreMetro) {
  notes.push(`${SHEET} predates the metro column — pre-D3 bake, legal, and the next bake adds it`);
} else if (sheetHeader.join(",") !== SHEET_COLUMNS.join(",")) {
  const missing = SHEET_COLUMNS.filter((c) => !sheetHeader.includes(c));
  const extra = sheetHeader.filter((c) => !SHEET_COLUMNS.includes(c));
  fail(
    `${SHEET} header is not the pinned column list` +
      (missing.length ? ` — missing [${missing.join(", ")}]` : "") +
      (extra.length ? ` — unexpected [${extra.join(", ")}]` : "") +
      (missing.length || extra.length ? "" : " — same columns, wrong order"),
  );
}
if (sheet.data.length !== g.nodes.length) {
  fail(`${SHEET} has ${sheet.data.length} row(s) but the graph has ${g.nodes.length} node(s)`);
}
const sheetIds = new Set<string>();
for (const [i, r] of sheet.data.entries()) {
  const id = (r.person_id ?? "").trim();
  if (!id) fail(`${SHEET} row ${i + 2} has no person_id`);
  if (sheetIds.has(id)) fail(`${SHEET} row ${i + 2}: duplicate person_id "${id}"`);
  sheetIds.add(id);
  if (!ids.has(id)) fail(`${SHEET} row ${i + 2}: person_id "${id}" is not a node in graph.json`);
}

/* ---- the overrides sheet: sparse, hand-managed, and never allowed to bind to nobody ---- */
let overrideRows = 0;
if (existsSync(OVERRIDES)) {
  const ovRaw = readFileSync(OVERRIDES, "utf8");
  for (const [label, re] of SHEET_PII) {
    const hit = re.exec(ovRaw);
    if (hit) fail(`PII tripwire hit in ${OVERRIDES}: ${label} at byte ${hit.index} — value withheld`);
  }
  const ov = Papa.parse<Record<string, string>>(ovRaw, { header: true, skipEmptyLines: true });
  if (ov.errors.length > 0) {
    fail(`${OVERRIDES} is unparseable: row ${ov.errors[0].row} — ${ov.errors[0].message}`);
  }
  const ovHeader = (ov.meta.fields ?? []).filter((h) => h !== "");
  const badCols = ovHeader.filter((c) => !OVERRIDE_COLUMNS.includes(c));
  if (badCols.length > 0) fail(`${OVERRIDES} has column(s) outside the contract: ${badCols.join(", ")}`);

  for (const [i, r] of ov.data.entries()) {
    const line = i + 2;
    const id = (r.person_id ?? "").trim();
    const hidden = ["true", "1", "yes", "y"].includes((r.hide ?? "").trim().toLowerCase());
    if (!id) {
      if (OVERRIDE_COLUMNS.some((c) => (r[c] ?? "").trim() !== "")) fail(`${OVERRIDES} line ${line} sets values but names no person_id`);
      continue;
    }
    overrideRows += 1;
    // A hidden person is legitimately absent from every artifact; anyone else must resolve.
    if (!ids.has(id) && !hidden) {
      fail(`${OVERRIDES} line ${line}: person_id "${id}" resolves to no node in graph.json (and is not hidden)`);
    }
    if (ids.has(id) && hidden) {
      fail(`${OVERRIDES} line ${line}: "${id}" is marked hide=true but still shipped as a node`);
    }
    for (const [col, vocab] of Object.entries(TAG_VOCAB)) {
      const v = (r[col] ?? "").trim();
      if (v !== "" && !vocab.includes(v)) {
        fail(`${OVERRIDES} line ${line}: ${col}="${v}" is outside the closed vocabulary (${vocab.length} allowed values)`);
      }
    }
    const pin = (r.pinned_match ?? "").trim();
    if (pin !== "" && !ids.has(pin)) {
      fail(`${OVERRIDES} line ${line}: pinned_match "${pin}" is not a node in graph.json`);
    }
  }
}

console.log(
  `emit OK: ${g.nodes.length} nodes, ${g.edges.length} edges, ${files.length} person files ` +
    `(graph.json ${(raw.length / 1024).toFixed(0)}KB · edges/record min ${minEdges} avg ${(edgeTotal / files.length).toFixed(1)} · ` +
    `highlights/record min ${minHighlights} avg ${(highlightTotal / files.length).toFixed(1)} · ` +
    `${hometowns} hometowns · ${numericClaims} numeric claims, none zero, no group of one)`,
);
console.log(
  `conviction OK: ${convictionBlocks} of ${files.length} records carry a block, all tags in the closed ` +
    `vocabularies and equal to their node · ${convictionReceipts} receipts, every one byte-verbatim in the ` +
    `guest's own answer, none behind an overridden tag`,
);
/* The render floor itself (INFER_EMIT_FLOOR in scripts/emit-graph.ts) is deliberately NOT
   re-asserted here: it is emit-time policy read from the environment, and this gate reads only
   what shipped. What ships is held to the LAW — vocabulary, range, provenance, verbatim spans —
   and the observed minimum is printed so a floor change is visible in the gate's own output. */
console.log(
  inferredBlocks === 0
    ? "inferred OK: no record carries an inferred block (no summaries artifact at bake time — legal, the input is optional)"
    : `inferred OK: ${inferredBlocks} of ${files.length} records carry a block [${inferredMissions} mission(s), ` +
      `${inferredImpacts} impact(s), min confidence ${inferredMinConfidence.toFixed(2)}], every label in the closed ` +
      `vocabularies, every one of ${inferredSpans} evidence span(s) byte-verbatim in that guest's own answers`,
);
console.log(
  placeCount === 0
    ? "places OK: graph.json ships no places array (pre-D3 artifact — legal, the emit input is optional)"
    : `places OK: ${placeCount} metro(s) covering ${placePeople} of ${g.nodes.length} people, every count equal to its own ` +
      `membership and every member a node · ${placeCoordCount} with coordinates, ${placeCount - placeCoordCount} counted ` +
      `but not drawable (an honest absence, never 0,0)`,
);
console.log(
  tasteBlocks === 0
    ? "taste OK: no record carries a taste block (pre-D3 artifact — legal)"
    : `taste OK: ${tasteBlocks} of ${files.length} records carry a block · ${tasteTwinQuotes} twin-side quote(s), every one ` +
      `byte-verbatim in that twin's OWN record, every claim symmetric`,
);
console.log(
  `sheet OK: ${SHEET} ${sheet.data.length} rows × ${sheetHeader.length} pinned columns, no contact PII · ` +
    `${OVERRIDES} ${overrideRows === 0 ? "header-only (no overrides in force)" : `${overrideRows} override row(s), all resolved and in-vocabulary`}`,
);
if (handleMentions > 0) {
  console.log(
    `note: ${handleMentions} "@handle" mention(s) allowed — inside the guests' own answers, no contact PII: ${handleSamples.join(", ")}`,
  );
}
// green, and green about WHAT — a block that was never there did not pass, it was absent
for (const n of notes) console.log(`note: ${n}`);
