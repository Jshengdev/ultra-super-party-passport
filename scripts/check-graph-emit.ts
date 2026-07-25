/**
 * scripts/check-graph-emit.ts — the G-emit gate for the baked party artifacts.
 *
 * Reads ONLY what shipped (public/graph/**) — never the private inputs — because the
 * question this answers is "is the thing we are about to serve safe and honest?".
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
 *   · a `direction` outside the contract enum, an edge pointing at nobody, a
 *     zero-count fact rendered as text, or an internal `flags` value leaking into copy
 *   · meta.stages / meta.guestIds missing (the entry drop-zone reads both)
 *   · meta.matchProvider missing or outside {gateway, tfidf} (the artifact must name which
 *     vector provider produced the SEEKS matches, not just the DB's per-rel `_src`)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const GRAPH = "public/graph/graph.json";
const PEOPLE_DIR = "public/graph/people";

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
}

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
for (const n of g.nodes) {
  if (!n.id || ids.has(n.id)) fail(`bad or duplicate node id: ${n.id}`);
  ids.add(n.id);
  if (typeof n.name !== "string" || n.name.length === 0) fail(`node ${n.id} has no name`);
  if (typeof n.deg !== "number") fail(`node ${n.id} has no deg`);
  for (const lens of ["web", "why", "seek"] as const) {
    const p = n.pos?.[lens];
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      fail(`node ${n.id} has no finite ${lens} position`);
    }
  }
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

  /* PII: contact shapes never, a handle mention only inside an answer */
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
}

console.log(
  `emit OK: ${g.nodes.length} nodes, ${g.edges.length} edges, ${files.length} person files ` +
    `(graph.json ${(raw.length / 1024).toFixed(0)}KB · edges/record min ${minEdges} avg ${(edgeTotal / files.length).toFixed(1)} · ` +
    `highlights/record min ${minHighlights} avg ${(highlightTotal / files.length).toFixed(1)} · ` +
    `${numericClaims} numeric claims, none zero, no group of one)`,
);
if (handleMentions > 0) {
  console.log(
    `note: ${handleMentions} "@handle" mention(s) allowed — inside the guests' own answers, no contact PII: ${handleSamples.join(", ")}`,
  );
}
