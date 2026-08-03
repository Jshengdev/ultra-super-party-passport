/**
 * scripts/write-conviction-values.ts — conviction tags → ValueClusters, through the gate.
 *
 * WHY THIS EXISTS. The belief-clustering pass (lib/cluster.ts) ran on the chat fallback and
 * produced 6 small clusters / 146 SHARES_VALUE edges, which left 122 of 312 guests with no
 * receipted values connection and therefore no passport. The conviction pass already holds a
 * second, INDEPENDENT read of the same answers — closed-vocabulary `mission` (the change they
 * want to make) and `impact` (the effect they want on an audience), each quote-grounded by
 * lib/conviction.ts's verbatim post-guard. Those tags are exactly a value grouping, so this
 * script turns every tag group of >= MIN_GROUP into a ValueCluster.
 *
 * It COEXISTS with the belief clusters rather than replacing them: different cluster ids
 * (`conv-mission-…` / `conv-impact-…`), so `MERGE (a)-[sv:SHARES_VALUE {cluster: vc.id}]->(b)`
 * adds edges beside the existing ones. Every edge is still receipted — valuesPath() returns the
 * real SHARES_VALUE edge with its `basis`.
 *
 * LAWS. Every write goes through `dispatch("write_value_cluster", …)` (law a) — no write-Cypher
 * here; the only direct `run()` calls are the read-only pre-flight and the post-write count.
 * Provenance {src:"conviction:tags", actor:"pipeline"} rides every dispatch (law d). Idempotent:
 * the action MERGEs the ValueCluster, the IN_CLUSTER edges, and the pairwise SHARES_VALUE edges,
 * so re-running converges instead of duplicating.
 *
 * DEGRADED (law b): no NEO4J_* → named Neo4jNotConfigured, exit 2. No GUESTS_CSV →
 * GuestsCsvMissing, exit 2. No convictions file → ConvictionsMissing, exit 2 (unlike the ingest,
 * this script has NOTHING to do without it — an empty run would be a silent no-op).
 *
 * Env:
 *   GUESTS_CSV       (required) path to the Luma guest export — the approved-guest allowlist
 *   CONVICTIONS_JSON (optional) conviction pass output; defaults to CONVICTIONS_PATH
 *   DRY_RUN=1        (optional) print the cluster plan (groups, sizes, predicted edges),
 *                    validate every payload against WriteValueClusterParams, touch no driver
 */
import { existsSync, readFileSync } from "node:fs";
import { loadGuests } from "../lib/guests";
import { CONVICTIONS_PATH, convictionsOf, type Conviction } from "../lib/conviction";
import { dispatch } from "../lib/ontology-gate";
import { isConfigured, run, toNum, close, Neo4jNotConfigured } from "../lib/neo4j";
import { WriteValueClusterParams } from "../ontology/manifest";

const PROV = { src: "conviction:tags", actor: "pipeline" } as const;

/**
 * A group of 2 is a single edge and reads as a coincidence, not a shared value; the action's own
 * zod floor is 2, so 3 is a deliberate quality bar on top of it.
 */
const MIN_GROUP = 3;

/**
 * The two conviction fields that describe a VALUE: the change they want to make, and the effect
 * they want to have. The other two are deliberately out: `aspiration` is a craft (already carried
 * by DOES→Activity via the ingest's craft tags), and `motive` is an origin story, not a value.
 *
 * COVERAGE LEVER: mission+impact are the CONSERVATIVE tags — lib/conviction.ts only assigns them
 * when a guest names the change/effect outright, so they cover 129 of 312 guests. Adding "motive"
 * here is a one-word change and would add 11 groups covering 284 people — but it doubles the
 * belief-clustering axis (this ingest maps `belief` = the `drew` answer, which is the same text
 * `motive` is tagged from), so those edges would largely restate clusters that already exist.
 */
const KINDS = ["mission", "impact"] as const;
type Kind = (typeof KINDS)[number];

interface ClusterPlan {
  id: string;
  kind: Kind;
  tag: string;
  name: string;
  basis: string;
  members: string[];
  /** pairwise SHARES_VALUE edges this cluster will MERGE (the action pairs a.id < b.id) */
  pairs: number;
}

/** "build-community" → "build community". Deliberately not title-cased: the tag is the claim. */
function pretty(tag: string): string {
  return tag.replace(/-/g, " ");
}

/**
 * Group the approved guests by mission tag and by impact tag, keep the groups of >= MIN_GROUP,
 * and shape each into the exact `write_value_cluster` payload. Deterministic: groups sorted by
 * size desc then tag asc, members sorted by personId.
 */
function buildPlan(convByPerson: Map<string, Conviction>): ClusterPlan[] {
  const plans: ClusterPlan[] = [];
  for (const kind of KINDS) {
    const groups = new Map<string, string[]>();
    for (const [personId, c] of convByPerson) {
      const tag = c[kind]?.trim();
      if (!tag) continue;
      const g = groups.get(tag);
      if (g) g.push(personId);
      else groups.set(tag, [personId]);
    }
    const kept = [...groups.entries()]
      .filter(([, members]) => members.length >= MIN_GROUP)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [tag, members] of kept) {
      const sorted = [...members].sort();
      plans.push({
        id: `conv-${kind}-${tag}`,
        kind,
        tag,
        name: pretty(tag),
        basis: `shared conviction: ${tag} (guarded extraction, quote-grounded)`,
        members: sorted,
        pairs: (sorted.length * (sorted.length - 1)) / 2,
      });
    }
  }
  return plans;
}

function payloadOf(p: ClusterPlan) {
  return {
    cluster: { id: p.id, name: p.name, basis: p.basis },
    members: p.members.map((personId) => ({ personId })),
  };
}

async function main(): Promise<number> {
  const dryRun = process.env.DRY_RUN === "1";

  if (!dryRun && !isConfigured()) {
    const missing = ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"].filter((k) => !process.env[k]);
    console.error(new Neo4jNotConfigured(missing).message);
    return 2;
  }
  const csv = process.env.GUESTS_CSV;
  if (!csv) {
    console.error("GuestsCsvMissing: set GUESTS_CSV to the guest export path");
    return 2;
  }
  const convPath = process.env.CONVICTIONS_JSON || CONVICTIONS_PATH;
  if (!existsSync(convPath)) {
    console.error(
      `ConvictionsMissing: ${convPath} does not exist — run scripts/enrich-convictions.ts first`,
    );
    return 2;
  }

  // The CSV is the allowlist: a conviction record for someone who is not an approved guest is
  // stale, and clustering them would mint SHARES_VALUE edges to a Person the graph doesn't hold.
  const guests = loadGuests(csv);
  const approved = new Set(guests.map((g) => g.personId));
  const raw = convictionsOf(JSON.parse(readFileSync(convPath, "utf8")));

  const convByPerson = new Map<string, Conviction>();
  let stale = 0;
  for (const [personId, c] of Object.entries(raw)) {
    if (!approved.has(personId)) {
      stale++;
      continue;
    }
    convByPerson.set(personId, c);
  }
  console.log(
    `convictions: ${convByPerson.size}/${guests.length} approved guest(s) have a record` +
      (stale ? ` · ${stale} stale record(s) ignored (not in the CSV)` : ""),
  );

  const plans = buildPlan(convByPerson);
  if (!plans.length) {
    console.error(
      `NoClusterableTags: no mission/impact tag reaches ${MIN_GROUP} members — refusing to write nothing silently`,
    );
    return 1;
  }

  const memberships = plans.reduce((a, p) => a + p.members.length, 0);
  const predictedPairs = plans.reduce((a, p) => a + p.pairs, 0);
  const people = new Set(plans.flatMap((p) => p.members));

  for (const kind of KINDS) {
    const of = plans.filter((p) => p.kind === kind);
    console.log(
      `\n${kind}: ${of.length} cluster(s) >= ${MIN_GROUP} members` +
        ` · ${of.reduce((a, p) => a + p.members.length, 0)} membership(s)` +
        ` · ${of.reduce((a, p) => a + p.pairs, 0)} predicted SHARES_VALUE edge(s)`,
    );
    for (const p of of) console.log(`  ${p.id.padEnd(38)} ${String(p.members.length).padStart(3)} members  ${p.pairs} pair(s)`);
  }
  console.log(
    `\nPLAN: ${plans.length} cluster(s) · ${memberships} membership(s) · ${people.size} distinct ` +
      `person/people · ${predictedPairs} predicted SHARES_VALUE edge(s) (pairwise, one per cluster per pair)`,
  );

  if (dryRun) {
    // The same zod the gate will run, minus the driver.
    const invalid: string[] = [];
    for (const p of plans) {
      const parsed = WriteValueClusterParams.safeParse(payloadOf(p));
      if (!parsed.success) {
        invalid.push(`${p.id}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
      }
    }
    console.error(
      `DRY_RUN: ${plans.length - invalid.length}/${plans.length} cluster(s) valid against ` +
        `WriteValueClusterParams; driver untouched.`,
    );
    if (invalid.length) {
      console.error(`INVALID (${invalid.length}):\n${invalid.join("\n")}`);
      return 1;
    }
    return 0;
  }

  // PRE-FLIGHT. write_value_cluster's Cypher does `MATCH (bel:Belief {personId: m.personId})`,
  // so a member with no Person or no Belief node is dropped SILENTLY — the action still returns
  // the cluster id. Name them before writing rather than discovering the hole in the audit.
  let writable = people.size;
  try {
    const res = await run(
      `MATCH (p:Person)-[:BELIEVES]->(:Belief) WHERE p.id IN $ids RETURN collect(p.id) AS ids`,
      { ids: [...people] },
    );
    const have = new Set((res.records[0]?.get("ids") ?? []).map(String));
    const absent = [...people].filter((id) => !have.has(id));
    writable = have.size;
    if (absent.length) {
      console.error(
        `\nPREFLIGHT: ${absent.length}/${people.size} planned member(s) have no Person+BELIEVES→Belief in the graph ` +
          `and WILL BE DROPPED by the action — run scripts/ingest-guests.ts first. ` +
          `Sample: ${absent.slice(0, 8).join(", ")}${absent.length > 8 ? " …" : ""}`,
      );
    }
    // A cluster left with <2 resolvable members mints a ValueCluster with zero edges.
    const thin = plans.filter((p) => p.members.filter((id) => have.has(id)).length < 2);
    if (thin.length) {
      console.error(`PREFLIGHT: ${thin.length} cluster(s) will land with <2 members → 0 edges: ${thin.map((p) => p.id).join(", ")}`);
    }
  } catch (e) {
    console.error(`PREFLIGHT skipped (read failed): ${(e as Error).message}`);
  }

  const failures: string[] = [];
  let ok = 0;
  for (const p of plans) {
    try {
      await dispatch("write_value_cluster", payloadOf(p), PROV);
      ok++;
    } catch (e) {
      failures.push(`${p.id}: ${(e as Error).message}`);
    }
  }
  console.log(`\nwrote ${ok}/${plans.length} conviction cluster(s)`);

  // PROVE IT (law c: never invent a count — re-read the graph). Scoped to `conv-` so the
  // belief-clustering edges are not counted as ours.
  try {
    const res = await run(
      `MATCH ()-[s:SHARES_VALUE]->() WHERE s.cluster STARTS WITH 'conv-'
       RETURN s.cluster AS cluster, count(s) AS n ORDER BY cluster`,
    );
    let actual = 0;
    for (const r of res.records) {
      const n = toNum(r.get("n"));
      actual += n;
      console.log(`  ${String(r.get("cluster")).padEnd(38)} ${String(n).padStart(4)} SHARES_VALUE edge(s)`);
    }
    const all = await run(`MATCH ()-[s:SHARES_VALUE]->() RETURN count(s) AS n`);
    const total = toNum(all.records[0].get("n"));
    console.log(
      `\nSHARES_VALUE math: ${actual} conviction edge(s) actual vs ${predictedPairs} predicted ` +
        `(${writable}/${people.size} members resolvable) · ${total} total in the graph, ` +
        `${total - actual} from the belief-clustering pass.`,
    );
    if (actual === 0) {
      failures.push("verification: 0 conviction SHARES_VALUE edges exist after the write");
    } else if (actual < predictedPairs) {
      console.error(
        `NOTE: ${predictedPairs - actual} predicted edge(s) missing — members without a Belief node ` +
          `are dropped by the action (see PREFLIGHT above); re-run after a full ingest.`,
      );
    }
  } catch (e) {
    failures.push(`verification: ${(e as Error).message}`);
  }

  if (failures.length) {
    console.error(`FAILURES (${failures.length}):\n${failures.join("\n")}`);
    return 1;
  }
  return 0;
}

main()
  .then(async (code) => {
    await close();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(`write-conviction-values FAILED: ${(e as Error).name}: ${(e as Error).message}`);
    await close();
    process.exit(1);
  });
