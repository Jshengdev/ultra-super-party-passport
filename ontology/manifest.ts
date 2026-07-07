/**
 * ontology/manifest.ts — THE single source of truth for the party-passport graph.
 *
 * Everything that can exist in Neo4j is declared here: object types (with zod props),
 * the link-type allowlist (patterns), the ACTION registry (the ONLY writes that exist),
 * and the READ traversal templates. `lib/ontology-gate.ts` is the only executor; it
 * refuses anything not declared here, so off-ontology labels/rels are unrepresentable.
 *
 * pepl grounding-by-construction: an unreceipted or off-ontology write cannot be spelled.
 */
import { z } from "zod";

/* ────────────────────────────── provenance ────────────────────────────── */
// Every node & rel written through the gate carries these. Injected by the gate,
// never by callers' business params.
export type Actor = "pipeline" | "agent" | "human";
export const PROVENANCE_KEYS = ["_src", "_ts", "_actor"] as const;

/* ───────────────────────────── object types ───────────────────────────── */
// Business props only (provenance is added by the gate). These schemas document the
// shape of each node label; the gate validates ACTION params, not raw nodes.
export const OBJECT_SCHEMAS = {
  Person: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email(),
    handles: z.string(), // JSON string: {"instagram": string|null, "x": string|null}
    grad_year: z.string().default(""),
    position: z.string().default(""), // derived role line (never an employer claim)
  }),
  School: z.object({ name: z.string().min(1) }),
  Major: z.object({ name: z.string().min(1) }),
  Company: z.object({ name: z.string().min(1) }),
  Activity: z.object({ name: z.string().min(1) }),
  Belief: z.object({ text: z.string(), personId: z.string().min(1) }),
  ValueCluster: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    basis: z.string().min(1),
  }),
  Party: z.object({ id: z.string().min(1), name: z.string().min(1), date: z.string().min(1) }),
  Interest: z.object({ name: z.string().min(1) }), // canonical lowercase 1-3 word semantic tag
} as const;

export type ObjectLabel = keyof typeof OBJECT_SCHEMAS;
export const OBJECT_TYPES = Object.keys(OBJECT_SCHEMAS) as ObjectLabel[];

/* ────────────────────────────── link types ────────────────────────────── */
export interface LinkPattern {
  from: ObjectLabel;
  rel: string;
  to: ObjectLabel;
  /** relationship property names allowed on this edge (beyond provenance) */
  props?: readonly string[];
}

export const LINKS: readonly LinkPattern[] = [
  { from: "Person", rel: "STUDIES_AT", to: "School" },
  { from: "Person", rel: "MAJORS_IN", to: "Major" },
  { from: "Person", rel: "WORKS_AT", to: "Company" },
  { from: "Person", rel: "DOES", to: "Activity" },
  { from: "Person", rel: "WORKING_ON", to: "Activity" },
  { from: "Person", rel: "BELIEVES", to: "Belief" },
  { from: "Belief", rel: "IN_CLUSTER", to: "ValueCluster" },
  { from: "Person", rel: "SHARES_VALUE", to: "Person", props: ["cluster", "basis"] },
  { from: "Person", rel: "SIGNED_UP", to: "Party", props: ["checked_in", "checked_in_at"] },
  { from: "Person", rel: "INTERESTED_IN", to: "Interest" },
] as const;

export const REL_TYPES = Array.from(new Set(LINKS.map((l) => l.rel)));

/* ──────────────────────────── allowlist helpers ────────────────────────── */
export function isAllowedLabel(label: string): label is ObjectLabel {
  return (OBJECT_TYPES as string[]).includes(label);
}

export function isAllowedPattern(from: string, rel: string, to: string): boolean {
  return LINKS.some((l) => l.from === from && l.rel === rel && l.to === to);
}

/* ─────────────────────────────── the party ─────────────────────────────── */
// The single event these passports are minted for. Shared by ingest + the checkin route.
export const DEFAULT_PARTY = {
  id: process.env.PARTY_ID || "la-intern-party-0718",
  name: process.env.PARTY_NAME || "LA Intern Party",
  date: "2026-07-18",
} as const;

/* ───────────────────────────── action registry ─────────────────────────── */
// Every write to the graph is one of these. The gate validates params against the
// zod schema, asserts every declared label/pattern is on the allowlist, injects
// provenance, and runs the parameterized Cypher. There is NO other write path.

export interface ActionDef {
  name: string;
  params: z.ZodTypeAny;
  /** labels this action may MERGE/SET — asserted against isAllowedLabel at dispatch */
  writesLabels: readonly ObjectLabel[];
  /** [from, rel, to] patterns this action may create — asserted against isAllowedPattern */
  writesPatterns: readonly [string, string, string][];
  /** parameterized Cypher; must RETURN a column `writtenIds` (list of ids) */
  cypher: string;
  defaultSrc: string;
  defaultActor: Actor;
}

/* ---- ingest_person: one person + all their edges, one idempotent transaction ---- */
export const IngestPersonParams = z.object({
  person: OBJECT_SCHEMAS.Person,
  school: z.string().nullable(),
  major: z.string().nullable(),
  company: z.string().nullable(),
  does: z.array(z.string()),
  workingOn: z.array(z.string()),
  belief: z.string().nullable(),
  party: OBJECT_SCHEMAS.Party,
});
export type IngestPersonParams = z.infer<typeof IngestPersonParams>;

const INGEST_PERSON_CYPHER = `
MERGE (p:Person {id: $person.id})
SET p.name = $person.name, p.email = $person.email, p.handles = $person.handles,
    p.grad_year = $person.grad_year, p.position = $person.position,
    p._src = $_src, p._ts = $_ts, p._actor = $_actor
MERGE (party:Party {id: $party.id})
SET party.name = $party.name, party.date = $party.date,
    party._src = $_src, party._ts = $_ts, party._actor = $_actor
MERGE (p)-[su:SIGNED_UP]->(party)
  ON CREATE SET su.checked_in = false, su.checked_in_at = null
SET su._src = $_src, su._ts = $_ts, su._actor = $_actor
FOREACH (s IN CASE WHEN $school IS NULL THEN [] ELSE [$school] END |
  MERGE (sch:School {name: s})
  SET sch._src = $_src, sch._ts = $_ts, sch._actor = $_actor
  MERGE (p)-[r:STUDIES_AT]->(sch)
  SET r._src = $_src, r._ts = $_ts, r._actor = $_actor)
FOREACH (m IN CASE WHEN $major IS NULL THEN [] ELSE [$major] END |
  MERGE (mj:Major {name: m})
  SET mj._src = $_src, mj._ts = $_ts, mj._actor = $_actor
  MERGE (p)-[r:MAJORS_IN]->(mj)
  SET r._src = $_src, r._ts = $_ts, r._actor = $_actor)
FOREACH (c IN CASE WHEN $company IS NULL THEN [] ELSE [$company] END |
  MERGE (co:Company {name: c})
  SET co._src = $_src, co._ts = $_ts, co._actor = $_actor
  MERGE (p)-[r:WORKS_AT]->(co)
  SET r._src = $_src, r._ts = $_ts, r._actor = $_actor)
FOREACH (a IN $does |
  MERGE (act:Activity {name: a})
  SET act._src = $_src, act._ts = $_ts, act._actor = $_actor
  MERGE (p)-[r:DOES]->(act)
  SET r._src = $_src, r._ts = $_ts, r._actor = $_actor)
FOREACH (a IN $workingOn |
  MERGE (act:Activity {name: a})
  SET act._src = $_src, act._ts = $_ts, act._actor = $_actor
  MERGE (p)-[r:WORKING_ON]->(act)
  SET r._src = $_src, r._ts = $_ts, r._actor = $_actor)
FOREACH (b IN CASE WHEN $belief IS NULL THEN [] ELSE [$belief] END |
  MERGE (bel:Belief {personId: $person.id})
  SET bel.text = b, bel._src = $_src, bel._ts = $_ts, bel._actor = $_actor
  MERGE (p)-[r:BELIEVES]->(bel)
  SET r._src = $_src, r._ts = $_ts, r._actor = $_actor)
RETURN [$person.id] AS writtenIds
`.trim();

/* ---- write_value_cluster: a named cluster + IN_CLUSTER + pairwise SHARES_VALUE ---- */
export const WriteValueClusterParams = z.object({
  cluster: OBJECT_SCHEMAS.ValueCluster,
  members: z.array(z.object({ personId: z.string().min(1) })).min(2),
});
export type WriteValueClusterParams = z.infer<typeof WriteValueClusterParams>;

const WRITE_VALUE_CLUSTER_CYPHER = `
MERGE (vc:ValueCluster {id: $cluster.id})
SET vc.name = $cluster.name, vc.basis = $cluster.basis,
    vc._src = $_src, vc._ts = $_ts, vc._actor = $_actor
WITH vc
UNWIND $members AS m
MATCH (p:Person {id: m.personId})
MATCH (bel:Belief {personId: m.personId})
MERGE (bel)-[ric:IN_CLUSTER]->(vc)
SET ric._src = $_src, ric._ts = $_ts, ric._actor = $_actor
WITH vc, collect(DISTINCT p) AS ppl
UNWIND ppl AS a
UNWIND ppl AS b
WITH vc, a, b WHERE a.id < b.id
MERGE (a)-[sv:SHARES_VALUE {cluster: vc.id}]->(b)
SET sv.basis = $cluster.basis, sv._src = $_src, sv._ts = $_ts, sv._actor = $_actor
RETURN [$cluster.id] AS writtenIds
`.trim();

/* ---- write_interests: the semantic layer — one-liner analysis distilled to shared tags ---- */
export const WriteInterestsParams = z.object({
  personId: z.string().min(1),
  interests: z.array(z.string().min(1).max(40)).min(1).max(4),
});
export type WriteInterestsParams = z.infer<typeof WriteInterestsParams>;

const WRITE_INTERESTS_CYPHER = `
MATCH (p:Person {id: $personId})
UNWIND $interests AS tag
MERGE (i:Interest {name: tag})
SET i._src = $_src, i._ts = $_ts, i._actor = $_actor
MERGE (p)-[r:INTERESTED_IN]->(i)
SET r._src = $_src, r._ts = $_ts, r._actor = $_actor
RETURN collect(DISTINCT i.name) AS writtenIds
`.trim();

/* ---- check_in: the kinetic layer — flip a SIGNED_UP edge's checked_in state ---- */
export const CheckInParams = z.object({
  personId: z.string().min(1),
  partyId: z.string().min(1),
  checkedIn: z.boolean().default(true),
});
export type CheckInParams = z.infer<typeof CheckInParams>;

const CHECK_IN_CYPHER = `
MATCH (p:Person {id: $personId})-[su:SIGNED_UP]->(party:Party {id: $partyId})
SET su.checked_in = $checkedIn,
    su.checked_in_at = CASE WHEN $checkedIn THEN $_ts ELSE null END,
    su._src = $_src, su._ts = $_ts, su._actor = $_actor
RETURN collect(p.id) AS writtenIds
`.trim();

export const ACTIONS = {
  ingest_person: {
    name: "ingest_person",
    params: IngestPersonParams,
    writesLabels: ["Person", "Party", "School", "Major", "Company", "Activity", "Belief"],
    writesPatterns: [
      ["Person", "SIGNED_UP", "Party"],
      ["Person", "STUDIES_AT", "School"],
      ["Person", "MAJORS_IN", "Major"],
      ["Person", "WORKS_AT", "Company"],
      ["Person", "DOES", "Activity"],
      ["Person", "WORKING_ON", "Activity"],
      ["Person", "BELIEVES", "Belief"],
    ],
    cypher: INGEST_PERSON_CYPHER,
    defaultSrc: "csv:test-party",
    defaultActor: "pipeline",
  },
  write_value_cluster: {
    name: "write_value_cluster",
    params: WriteValueClusterParams,
    writesLabels: ["ValueCluster", "Belief", "Person"],
    writesPatterns: [
      ["Belief", "IN_CLUSTER", "ValueCluster"],
      ["Person", "SHARES_VALUE", "Person"],
    ],
    cypher: WRITE_VALUE_CLUSTER_CYPHER,
    defaultSrc: "action:write_value_cluster",
    defaultActor: "pipeline",
  },
  write_interests: {
    name: "write_interests",
    params: WriteInterestsParams,
    writesLabels: ["Person", "Interest"],
    writesPatterns: [["Person", "INTERESTED_IN", "Interest"]],
    cypher: WRITE_INTERESTS_CYPHER,
    defaultSrc: "semantic:one-liner",
    defaultActor: "pipeline",
  },
  check_in: {
    name: "check_in",
    params: CheckInParams,
    writesLabels: ["Person", "Party"],
    writesPatterns: [["Person", "SIGNED_UP", "Party"]],
    cypher: CHECK_IN_CYPHER,
    defaultSrc: "action:check_in",
    defaultActor: "human",
  },
} as const satisfies Record<string, ActionDef>;

export type ActionName = keyof typeof ACTIONS;

/* ───────────────────────── read traversal templates ────────────────────── */
// Declared reads the app (passports, universe) traverses. Params documented inline.
// These are the counterpart to ACTIONS on the read side; they never mutate.
export const READS = {
  // same-work find: people who DO the same activity as $personId
  same_work_path: {
    name: "same_work_path",
    cypher: `
MATCH path = (p:Person {id: $personId})-[:DOES]->(a:Activity)<-[:DOES]-(other:Person)
WHERE other.id <> $personId
RETURN other.id AS personId, other.name AS name, a.name AS activity,
       [{ from: $personId, rel: 'DOES', to: a.name },
        { from: other.id, rel: 'DOES', to: a.name }] AS path_receipt
ORDER BY other.name
LIMIT $limit`.trim(),
    params: z.object({ personId: z.string(), limit: z.number().int().positive().default(10) }),
  },
  // values-aligned find: people who SHARE_VALUE with $personId (undirected)
  values_path: {
    name: "values_path",
    cypher: `
MATCH (p:Person {id: $personId})-[sv:SHARES_VALUE]-(other:Person)
RETURN other.id AS personId, other.name AS name, sv.cluster AS cluster, sv.basis AS basis,
       [{ from: $personId, rel: 'SHARES_VALUE', to: other.id }] AS path_receipt
ORDER BY other.name
LIMIT $limit`.trim(),
    params: z.object({ personId: z.string(), limit: z.number().int().positive().default(10) }),
  },
  // full neighborhood of a person (for panels / debugging)
  person_neighborhood: {
    name: "person_neighborhood",
    cypher: `
MATCH (p:Person {id: $personId})-[r]-(n)
RETURN type(r) AS rel, startNode(r).id = $personId AS outgoing, labels(n) AS labels,
       coalesce(n.name, n.id, n.text) AS node`.trim(),
    params: z.object({ personId: z.string() }),
  },
} as const;

export type ReadName = keyof typeof READS;
