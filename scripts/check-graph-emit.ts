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
  "hometown", "instagram",
  "motive", "mission", "impact", "aspiration", "open_seeker",
  "motive_quote", "mission_quote", "impact_quote",
  "school_node", "company_node", "craft_node",
  "conviction_groups",
  "match_1", "match_2", "match_3", "match_4", "match_5",
  "inbound_count", "mutual_with", "doppelganger", "doppelganger_score",
  "pinned_match", "hide", "host_notes",
  "flags", "extraction_model", "match_provider",
];
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

interface GNode {
  id: string;
  name: string;
  title: string;
  school: string | null;
  company: string | null;
  free: boolean;
  hometown?: string | null;
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
interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  meta: {
    people: number;
    built: string;
    counts: Record<string, number>;
    stages: Record<string, number>;
    guestIds: string[];
    matchProvider?: string;
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
  _overridden?: string[];
}

/**
 * The pinned key set of the `inferred` block. A key outside it is a register nobody declared —
 * the whole value of the third register is that a consumer knows exactly what it is looking at.
 */
const INFERRED_KEYS = new Set(["summary", "mission", "impact", "_src", "_model"]);
/** The answer fields an inferred evidence span may cite (the four the summary pass is shown). */
const INFERRED_EVIDENCE_FIELDS = new Set(["goal", "drew", "seeking", "inspiration"]);

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
if (sheetHeader.join(",") !== SHEET_COLUMNS.join(",")) {
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
  `sheet OK: ${SHEET} ${sheet.data.length} rows × ${sheetHeader.length} pinned columns, no contact PII · ` +
    `${OVERRIDES} ${overrideRows === 0 ? "header-only (no overrides in force)" : `${overrideRows} override row(s), all resolved and in-vocabulary`}`,
);
if (handleMentions > 0) {
  console.log(
    `note: ${handleMentions} "@handle" mention(s) allowed — inside the guests' own answers, no contact PII: ${handleSamples.join(", ")}`,
  );
}
