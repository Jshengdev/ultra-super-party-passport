/**
 * app/api/graph/route.ts — GET the whole party graph, shaped for the Universe.
 *
 * Response (200):  { nodes: [{id,label,type,cluster?}], links: [{source,target,type}], meta }
 * Demo (200):      ?demo=1 → a static fixture (SHAPES-derived) so the UI is buildable
 *                  + demoable BEFORE Aura creds land.
 * Degraded (503):  no Neo4j creds → { error: 'Neo4jNotConfigured', message }.
 * Failed (500):    creds present but the read/shape blew up → { error: 'GraphQueryFailed' }.
 *                  (Fail loud — sayhello law. No silent fallback to demo when creds exist.)
 *
 * All reads go through the shared surface `lib/neo4j.ts` (`run` + `isConfigured`).
 */

import { isConfigured, run, Neo4jNotConfigured } from '@/lib/neo4j';
import {
  demoPayload,
  nodeIdOf,
  primaryType,
  type GraphLink,
  type GraphNode,
  type GraphPayload,
  type LinkType,
  type NodeType,
} from '@/app/universe/lib/graph';

export const runtime = 'nodejs';
export const dynamic = 'force-static'; // export build bakes the live graph snapshot; dev refetches per request

const NODE_TYPES: NodeType[] = ['Person', 'School', 'Major', 'Company', 'Activity', 'ValueCluster', 'Interest'];
const AFFINITY_REL_TYPES: LinkType[] = ['STUDIES_AT', 'MAJORS_IN', 'WORKS_AT', 'DOES', 'WORKING_ON', 'SHARES_VALUE', 'INTERESTED_IN'];

// --- coercion helpers ------------------------------------------------------
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function labelsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function propsOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Natural key used by nodeIdOf: Person->id, ValueCluster->id, others->name. */
function keyFor(type: NodeType, props: Record<string, unknown>): string | undefined {
  if (type === 'Person' || type === 'ValueCluster') return asStr(props.id);
  return asStr(props.name);
}
function displayLabel(type: NodeType, props: Record<string, unknown>): string {
  return asStr(props.name) ?? asStr(props.id) ?? asStr(props.text) ?? type;
}

interface RawRows {
  nodeRows: { labels: string[]; props: Record<string, unknown> }[];
  clusterRows: { pid: string; cids: string[] }[];
  beliefRows: { pid: string; beliefs: string[] }[];
  linkRows: { t: string; al: string[]; ap: Record<string, unknown>; bl: string[]; bp: Record<string, unknown> }[];
}

async function readRaw(): Promise<RawRows> {
  const [nodeRes, clusterRes, beliefRes, linkRes] = await Promise.all([
    run(
      `MATCH (n) WHERE any(l IN labels(n) WHERE l IN $types)
       RETURN labels(n) AS labels, properties(n) AS props`,
      { types: NODE_TYPES },
    ),
    run(
      `MATCH (p:Person)-[:BELIEVES]->(:Belief)-[:IN_CLUSTER]->(c:ValueCluster)
       RETURN p.id AS pid, collect(DISTINCT c.id) AS cids`,
    ),
    run(
      `MATCH (p:Person)-[:BELIEVES]->(b:Belief)
       RETURN p.id AS pid, collect(DISTINCT b.text) AS beliefs`,
    ),
    run(
      `MATCH (a)-[r]->(b)
       WHERE type(r) IN $rels
         AND any(l IN labels(a) WHERE l IN $types)
         AND any(l IN labels(b) WHERE l IN $types)
       RETURN type(r) AS t, labels(a) AS al, properties(a) AS ap,
              labels(b) AS bl, properties(b) AS bp`,
      { types: NODE_TYPES, rels: AFFINITY_REL_TYPES },
    ),
  ]);

  return {
    nodeRows: nodeRes.records.map((r) => {
      const o = r.toObject();
      return { labels: labelsOf(o.labels), props: propsOf(o.props) };
    }),
    clusterRows: clusterRes.records
      .map((r) => ({ pid: asStr(r.get('pid')) ?? '', cids: asStrArr(r.get('cids')) }))
      .filter((r) => r.pid),
    beliefRows: beliefRes.records
      .map((r) => ({ pid: asStr(r.get('pid')) ?? '', beliefs: asStrArr(r.get('beliefs')) }))
      .filter((r) => r.pid),
    linkRows: linkRes.records.map((r) => {
      const o = r.toObject();
      return {
        t: asStr(o.t) ?? '',
        al: labelsOf(o.al),
        ap: propsOf(o.ap),
        bl: labelsOf(o.bl),
        bp: propsOf(o.bp),
      };
    }),
  };
}

/** Pure transform: raw Neo4j rows -> the wire payload. */
function shapeGraph(raw: RawRows): GraphPayload {
  // primary cluster per person (deterministic: min id) + all memberships
  const primaryCluster = new Map<string, string>();
  const memberships: { pid: string; cid: string }[] = [];
  for (const { pid, cids } of raw.clusterRows) {
    const sorted = [...cids].sort();
    if (sorted.length > 0) primaryCluster.set(pid, sorted[0]);
    for (const cid of cids) memberships.push({ pid, cid });
  }
  const firstBelief = new Map<string, string>();
  for (const { pid, beliefs } of raw.beliefRows) {
    if (beliefs.length > 0) firstBelief.set(pid, beliefs[0]);
  }

  const nodes = new Map<string, GraphNode>();
  for (const { labels, props } of raw.nodeRows) {
    const type = primaryType(labels);
    if (!type) continue;
    const key = keyFor(type, props);
    if (!key) continue;
    const id = nodeIdOf(type, key);
    if (nodes.has(id)) continue;
    const node: GraphNode = { id, label: displayLabel(type, props), type };
    if (type === 'Person') {
      const cl = primaryCluster.get(key);
      if (cl) node.cluster = cl;
      const belief = firstBelief.get(key) ?? asStr(props.belief);
      if (belief) node.belief = belief;
      const line2 = asStr(props.company) ?? asStr(props.school);
      if (line2) node.line2 = line2;
    } else if (type === 'ValueCluster') {
      node.cluster = key;
    }
    nodes.set(id, node);
  }

  const links = new Map<string, GraphLink>();
  const addLink = (source: string, target: string, type: LinkType) => {
    if (!nodes.has(source) || !nodes.has(target) || source === target) return;
    links.set(`${source}|${target}|${type}`, { source, target, type });
  };
  for (const row of raw.linkRows) {
    const aType = primaryType(row.al);
    const bType = primaryType(row.bl);
    if (!aType || !bType) continue;
    const aKey = keyFor(aType, row.ap);
    const bKey = keyFor(bType, row.bp);
    if (!aKey || !bKey) continue;
    addLink(nodeIdOf(aType, aKey), nodeIdOf(bType, bKey), (row.t || 'DOES') as LinkType);
  }
  for (const { pid, cid } of memberships) {
    addLink(nodeIdOf('Person', pid), nodeIdOf('ValueCluster', cid), 'IN_CLUSTER');
  }

  const nodeList = [...nodes.values()];
  return {
    nodes: nodeList,
    links: [...links.values()],
    meta: {
      source: 'live',
      counts: {
        people: nodeList.filter((n) => n.type === 'Person').length,
        clusters: nodeList.filter((n) => n.type === 'ValueCluster').length,
        nodes: nodeList.length,
        links: links.size,
      },
    },
  };
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

// No request param: static-exportable (query strings don't exist in a static world).
// Demo fixture = explicit env opt-in (GRAPH_DEMO=1) — never a silent fallback when creds exist.
export async function GET(): Promise<Response> {
  if (process.env.GRAPH_DEMO === '1') {
    return json(demoPayload(), 200);
  }

  if (!isConfigured()) {
    return json(
      {
        error: 'Neo4jNotConfigured',
        message:
          'Neo4j Aura is not configured (missing NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD). ' +
          'Running in DEGRADED mode — call /api/graph?demo=1 for the static fixture.',
      },
      503,
    );
  }

  try {
    const payload = shapeGraph(await readRaw());
    return json(payload, 200);
  } catch (err) {
    // Degraded creds can also surface as a thrown NotConfigured from lib/neo4j.
    if (err instanceof Neo4jNotConfigured) {
      return json({ error: 'Neo4jNotConfigured', message: err.message }, 503);
    }
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: 'GraphQueryFailed', message }, 500);
  }
}
