/**
 * app/universe/lib/graph.ts — the Universe graph payload shape + pure helpers.
 *
 * This module is deliberately React-free and side-effect-free so BOTH the server
 * route (`app/api/graph/route.ts`) and the client components can import it.
 *
 * The wire shape is pinned by the usp-v1 contract (SHARED SHAPES):
 *   { nodes: [{ id, label, type, cluster? }], links: [{ source, target, type }] }
 *
 * Person nodes carry two OPTIONAL enrichment fields (`belief`, `line2`) used by
 * the side panel. They are additive — a consumer that only reads {id,label,type,
 * cluster} is unaffected. (Reported as a GOOD deviation: extends the base node
 * shape with optional, panel-only fields; base contract preserved.)
 */

/** The six node types the Universe renders (Belief / Party are intentionally excluded). */
export type NodeType =
  | 'Person'
  | 'School'
  | 'Major'
  | 'Company'
  | 'Activity'
  | 'ValueCluster'
  | 'Interest';

/** The affinity node types (everything that is not a Person or a ValueCluster). */
export const AFFINITY_TYPES: NodeType[] = ['School', 'Major', 'Company', 'Activity'];

/** The semantic layer: interests distilled from what each guest SAID. */
export const SEMANTIC_TYPES: NodeType[] = ['Interest'];

/** Link types rendered in the Universe (subset of the manifest allowlist that lives between rendered nodes). */
export type LinkType =
  | 'STUDIES_AT'
  | 'MAJORS_IN'
  | 'WORKS_AT'
  | 'DOES'
  | 'WORKING_ON'
  | 'SHARES_VALUE'
  | 'IN_CLUSTER'
  | 'INTERESTED_IN';

/** The relationship types we read straight out of the graph (Person -> node). */
export const AFFINITY_RELS: LinkType[] = [
  'STUDIES_AT',
  'MAJORS_IN',
  'WORKS_AT',
  'DOES',
  'WORKING_ON',
];

export interface GraphNode {
  id: string;
  label: string;
  type: NodeType;
  /** ValueCluster id this node belongs to / represents; drives hue. Undefined = uncategorized. */
  cluster?: string | null;
  // --- Person-only optional enrichment (additive; see file header) ---
  /** company || school, for the panel subtitle. */
  line2?: string;
  /** the person's belief answer text, for the panel quote. */
  belief?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  type: LinkType;
}

export interface GraphMeta {
  source: 'live' | 'demo';
  counts: { people: number; clusters: number; nodes: number; links: number };
}

export interface GraphPayload {
  nodes: GraphNode[];
  links: GraphLink[];
  meta: GraphMeta;
}

/** Stable node-id scheme. Person ids stay raw (so /passport/<id> works); others are namespaced. */
export function nodeIdOf(type: NodeType, key: string): string {
  if (type === 'Person') return key;
  if (type === 'ValueCluster') return `cluster:${key}`;
  return `${type.toLowerCase()}:${key}`;
}

const TYPE_PRIORITY: NodeType[] = [
  'Person',
  'ValueCluster',
  'Company',
  'School',
  'Major',
  'Activity',
  'Interest',
];

/** Pick the single rendered type from a node's Neo4j label set. */
export function primaryType(labels: string[]): NodeType | null {
  for (const t of TYPE_PRIORITY) if (labels.includes(t)) return t;
  return null;
}

/** Adjacency for the side panel: nodeId -> its typed neighbors (with direction). */
export interface Neighbor {
  node: GraphNode;
  rel: LinkType;
  dir: 'out' | 'in';
}

export function buildAdjacency(payload: GraphPayload): Map<string, Neighbor[]> {
  const byId = new Map(payload.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, Neighbor[]>();
  const push = (from: string, n: Neighbor) => {
    const list = adj.get(from);
    if (list) list.push(n);
    else adj.set(from, [n]);
  };
  for (const l of payload.links) {
    const a = byId.get(l.source);
    const b = byId.get(l.target);
    if (!a || !b) continue;
    push(a.id, { node: b, rel: l.type, dir: 'out' });
    push(b.id, { node: a, rel: l.type, dir: 'in' });
  }
  return adj;
}

// ---------------------------------------------------------------------------
// DEMO FIXTURE — a small, static graph derived from the SHARES CSV columns
// (name / school / major / what_you_do / working_on / belief_creative). Served
// by /api/graph?demo=1 so the Universe is buildable + demoable BEFORE Aura creds
// land. Two value clusters of >=2 members each; affinity hubs; SHARES_VALUE peers.
// This is fabricated placeholder data, clearly namespaced under meta.source='demo'.
// ---------------------------------------------------------------------------

interface DemoPerson {
  id: string;
  name: string;
  school: string;
  major: string;
  company?: string;
  does: string;
  workingOn: string;
  belief: string;
  cluster: string;
}

const DEMO_PEOPLE: DemoPerson[] = [
  { id: 'p-ava', name: 'Ava Chen', school: 'Stanford', major: 'Computer Science', company: 'Figma', does: 'design engineering', workingOn: 'a generative canvas', belief: 'Creativity is taste made executable.', cluster: 'build-to-change' },
  { id: 'p-noah', name: 'Noah Kim', school: 'MIT', major: 'Computer Science', company: 'Ramp', does: 'infra engineering', workingOn: 'an agent runtime', belief: 'Making something that did not exist is the whole game.', cluster: 'build-to-change' },
  { id: 'p-mia', name: 'Mia Torres', school: 'Stanford', major: 'Symbolic Systems', company: 'Notion', does: 'product design', workingOn: 'a memory layer for teams', belief: 'Creativity is connecting people to what they already mean.', cluster: 'build-to-change' },
  { id: 'p-leo', name: 'Leo Park', school: 'RISD', major: 'Illustration', does: 'motion design', workingOn: 'a hand-drawn type family', belief: 'Creativity is honest attention to a feeling.', cluster: 'art-first' },
  { id: 'p-sofia', name: 'Sofia Alvarez', school: 'RISD', major: 'Film', does: 'directing', workingOn: 'a short about memory', belief: 'Creativity is telling the truth in a new shape.', cluster: 'art-first' },
  { id: 'p-jae', name: 'Jae Wu', school: 'CalArts', major: 'Music', does: 'composing', workingOn: 'a generative ambient record', belief: 'Creativity is listening until the pattern shows up.', cluster: 'art-first' },
  { id: 'p-omar', name: 'Omar Haddad', school: 'Berkeley', major: 'Design', company: 'Figma', does: 'brand design', workingOn: 'a color system', belief: 'Creativity is making the abstract feel touchable.', cluster: 'craft-and-care' },
  { id: 'p-ivy', name: 'Ivy Nguyen', school: 'Berkeley', major: 'Cognitive Science', company: 'Notion', does: 'research', workingOn: 'a study on why tools feel alive', belief: 'Creativity is caring about the person on the other side.', cluster: 'craft-and-care' },
];

const DEMO_CLUSTERS: { id: string; name: string }[] = [
  { id: 'build-to-change', name: 'build-to-change' },
  { id: 'art-first', name: 'art-first' },
  { id: 'craft-and-care', name: 'craft-and-care' },
];

// hand-authored SHARES_VALUE peer edges (within-cluster resonance)
const DEMO_SHARES: [string, string][] = [
  ['p-ava', 'p-noah'],
  ['p-ava', 'p-mia'],
  ['p-noah', 'p-mia'],
  ['p-leo', 'p-sofia'],
  ['p-sofia', 'p-jae'],
  ['p-omar', 'p-ivy'],
];

/** Build the demo payload fresh each call (no shared mutable references). */
export function demoPayload(): GraphPayload {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const seenNode = new Set<string>();
  const seenLink = new Set<string>();

  const addNode = (n: GraphNode) => {
    if (seenNode.has(n.id)) return;
    seenNode.add(n.id);
    nodes.push(n);
  };
  const addLink = (source: string, target: string, type: LinkType) => {
    const k = `${source}|${target}|${type}`;
    if (seenLink.has(k)) return;
    seenLink.add(k);
    links.push({ source, target, type });
  };

  for (const c of DEMO_CLUSTERS) {
    addNode({ id: nodeIdOf('ValueCluster', c.id), label: c.name, type: 'ValueCluster', cluster: c.id });
  }

  for (const p of DEMO_PEOPLE) {
    addNode({
      id: p.id,
      label: p.name,
      type: 'Person',
      cluster: p.cluster,
      line2: p.company ?? p.school,
      belief: p.belief,
    });

    const school = nodeIdOf('School', p.school);
    addNode({ id: school, label: p.school, type: 'School' });
    addLink(p.id, school, 'STUDIES_AT');

    const major = nodeIdOf('Major', p.major);
    addNode({ id: major, label: p.major, type: 'Major' });
    addLink(p.id, major, 'MAJORS_IN');

    if (p.company) {
      const company = nodeIdOf('Company', p.company);
      addNode({ id: company, label: p.company, type: 'Company' });
      addLink(p.id, company, 'WORKS_AT');
    }

    const does = nodeIdOf('Activity', p.does);
    addNode({ id: does, label: p.does, type: 'Activity' });
    addLink(p.id, does, 'DOES');

    const workingOn = nodeIdOf('Activity', p.workingOn);
    addNode({ id: workingOn, label: p.workingOn, type: 'Activity' });
    addLink(p.id, workingOn, 'WORKING_ON');

    addLink(p.id, nodeIdOf('ValueCluster', p.cluster), 'IN_CLUSTER');
  }

  for (const [a, b] of DEMO_SHARES) {
    addLink(a, b, 'SHARES_VALUE');
  }

  const people = nodes.filter((n) => n.type === 'Person').length;
  const clusters = nodes.filter((n) => n.type === 'ValueCluster').length;
  return {
    nodes,
    links,
    meta: { source: 'demo', counts: { people, clusters, nodes: nodes.length, links: links.length } },
  };
}
