/**
 * scripts/check-universe.ts — the G2 (universe) goal-gate checker.
 *
 * Invokes the /api/graph route handler DIRECTLY (no dev server needed), then
 * asserts the Universe can render every person from the test CSV, with value
 * clusters. Fail-loud: every leg that is not met prints why.
 *
 * Exit codes (per the "degraded/failed" contract):
 *   0  MET       live graph: all CSV people present + >=2 clusters of >=2.
 *   1  FAILED    live graph but a CSV person is missing, or clusters insufficient.
 *   2  ERROR     unexpected — the route threw / returned 500.
 *   3  NOT-READY degraded (no Neo4j creds → demo shape verified) OR no test CSV yet
 *                OR the route module can't load yet (a dependency window is behind).
 *
 * Run:  npx tsx scripts/check-universe.ts   (via: npm run verify:goal -- universe)
 */

import { promises as fs } from 'fs';
import path from 'path';
import Papa from 'papaparse';
import type { GraphPayload } from '@/app/universe/lib/graph';

const CSV_PATH = path.join(process.cwd(), 'data', 'test-party.csv');

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function log(msg: string): void {
  console.log(`check-universe: ${msg}`);
}

async function readExpectedNames(): Promise<string[] | null> {
  let text: string;
  try {
    text = await fs.readFile(CSV_PATH, 'utf8');
  } catch {
    return null;
  }
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const names = (parsed.data ?? [])
    .map((r) => (r.name ?? '').trim())
    .filter((n) => n.length > 0);
  return names;
}

function summarizeClusters(payload: GraphPayload): { clusters: Map<string, number>; peopleWithCluster: number } {
  const clusters = new Map<string, number>();
  let peopleWithCluster = 0;
  for (const n of payload.nodes) {
    if (n.type === 'Person' && n.cluster) {
      peopleWithCluster++;
      clusters.set(n.cluster, (clusters.get(n.cluster) ?? 0) + 1);
    }
  }
  return { clusters, peopleWithCluster };
}

function clustersMeetBar(clusters: Map<string, number>): boolean {
  // G3 bar: >=2 clusters each with >=2 members.
  const bigEnough = [...clusters.values()].filter((c) => c >= 2);
  return bigEnough.length >= 2;
}

async function callGraph(GET: (req: Request) => Promise<Response>, demo: boolean): Promise<Response> {
  const url = `http://localhost/api/graph${demo ? '?demo=1' : ''}`;
  return GET(new Request(url));
}

async function main(): Promise<number> {
  // Load the route handler. If the module can't import yet (e.g. lib/neo4j not
  // landed by its window), that's NOT-READY, not a hard failure.
  let GET: (req: Request) => Promise<Response>;
  try {
    const mod = (await import('@/app/api/graph/route')) as { GET: (req: Request) => Promise<Response> };
    GET = mod.GET;
  } catch (err) {
    log(`NOT-READY — /api/graph route did not load (a dependency may be behind): ${String(err)}`);
    return 3;
  }

  const expected = await readExpectedNames();

  // Hit the live route first.
  let res: Response;
  try {
    res = await callGraph(GET, false);
  } catch (err) {
    log(`ERROR — GET /api/graph threw: ${String(err)}`);
    return 2;
  }

  if (res.status === 503) {
    // Degraded: no creds. Verify the DEMO fixture at least renders a valid shape.
    const demoRes = await callGraph(GET, true);
    if (demoRes.status !== 200) {
      log(`ERROR — degraded, and demo fixture returned ${demoRes.status}`);
      return 2;
    }
    const demo = (await demoRes.json()) as GraphPayload;
    const { clusters } = summarizeClusters(demo);
    const people = demo.nodes.filter((n) => n.type === 'Person').length;
    log(
      `NOT-READY — Neo4j not configured (503). Demo fixture OK: ${people} people, ` +
        `${clusters.size} clusters, ${demo.links.length} links. Live people-set UNVERIFIED (needs Aura creds).`,
    );
    return 3;
  }

  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    log(`ERROR — GET /api/graph returned ${res.status}: ${body}`);
    return 2;
  }

  const payload = (await res.json()) as GraphPayload;
  const personNodes = payload.nodes.filter((n) => n.type === 'Person');
  log(`live graph: ${personNodes.length} people, ${payload.links.length} links, ${payload.meta?.counts?.clusters ?? 0} clusters.`);

  if (expected === null) {
    log('NOT-READY — data/test-party.csv not found; cannot verify the people-set. (ingest/gen step not run yet.)');
    return 3;
  }

  // 1) every CSV person is present as a Person node
  const presentNames = new Set(personNodes.map((n) => norm(n.label)));
  const missing = expected.filter((name) => !presentNames.has(norm(name)));
  if (missing.length > 0) {
    log(`FAILED — ${missing.length}/${expected.length} CSV people missing from the graph:`);
    for (const m of missing.slice(0, 12)) log(`  · ${m}`);
    if (missing.length > 12) log(`  … and ${missing.length - 12} more`);
    return 1;
  }
  log(`OK — all ${expected.length} CSV people present.`);

  // 2) value clusters present at the G3 bar
  const { clusters, peopleWithCluster } = summarizeClusters(payload);
  if (!clustersMeetBar(clusters)) {
    log(
      `FAILED — people present but value clusters insufficient: ${clusters.size} cluster(s), ` +
        `${peopleWithCluster} people clustered (need >=2 clusters of >=2). (G3 values leg not done?)`,
    );
    return 1;
  }
  log(`OK — ${clusters.size} clusters, ${peopleWithCluster} people carry a cluster id.`);

  log('MET — the Universe renders all test-CSV people with cluster ids.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`ERROR — unexpected: ${String(err)}`);
    process.exit(2);
  });
