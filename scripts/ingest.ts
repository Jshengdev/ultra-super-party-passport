/**
 * scripts/ingest.ts — the build-loop pipeline runner.
 *
 * Phase 1 (G4): papaparse data/test-party.csv → dispatch ingest_person per row.  Needs Neo4j.
 * Phase 2 (G3): embed beliefs → cluster → write ValueClusters.                    Needs Butterbase.
 *
 * DEGRADED law: missing creds → print the NAMED error and exit 2 (never a silent skip).
 * Phase 1 runs whenever Neo4j is present, so downstream conformance passes even if the
 * gateway is absent. Set SKIP_CLUSTER=1 to run ingest-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseCsv, ingestAll } from "@/lib/ingest";
import { runClustering } from "@/lib/cluster";
import { isConfigured, Neo4jNotConfigured, close } from "@/lib/neo4j";
import { isGatewayConfigured } from "@/lib/gateway";

const CSV_PATH = process.env.CSV_PATH || "data/test-party.csv";

async function main(): Promise<number> {
  if (!existsSync(CSV_PATH)) {
    console.error(`ingest: missing ${CSV_PATH} — run \`pnpm gen:csv\` first`);
    return 1;
  }
  if (!isConfigured()) {
    console.error(new Neo4jNotConfigured(["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"]).message);
    return 2;
  }

  // ── Phase 1: ingest people ──────────────────────────────────────────────
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
  console.log(`ingest: parsed ${rows.length} rows`);
  const people = await ingestAll(rows);
  console.log(`ingest: dispatched ingest_person for ${people.length} people`);

  // ── Phase 2: cluster beliefs into ValueClusters ─────────────────────────
  if (process.env.SKIP_CLUSTER === "1") {
    console.log("ingest: SKIP_CLUSTER=1 — clustering skipped (ingest-only)");
    return 0;
  }
  if (!isGatewayConfigured()) {
    console.error(
      "ingest: Butterbase gateway not configured — people ingested OK, but VALUE CLUSTERS were " +
        "NOT built (G3 incomplete). Set BUTTERBASE_GATEWAY_URL + BUTTERBASE_API_KEY and re-run, " +
        "or SKIP_CLUSTER=1 to accept ingest-only.",
    );
    return 2;
  }
  const { clusters, members, written } = await runClustering();
  console.log(
    `ingest: clustering wrote ${clusters} cluster(s) covering ${members} people (${written.length} cluster id(s))`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await close();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(`ingest: FAILED — ${e instanceof Error ? e.stack || e.message : String(e)}`);
    await close();
    process.exit(1);
  });
