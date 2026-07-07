/**
 * scripts/check-values.ts — G3 gate. Proves clustering produced real structure.
 *
 *   • >= 2 ValueClusters each with >= 2 members (Belief)-[:IN_CLUSTER]->(ValueCluster)
 *   • no (Person)-[:SHARES_VALUE]->(Person) edge missing its `basis` prop
 *
 * exit 0 = met · exit 1 = not met · exit 2 = Neo4j not configured (degraded).
 */
import { run, isConfigured, close, toNum, Neo4jNotConfigured } from "@/lib/neo4j";

async function main(): Promise<number> {
  if (!isConfigured()) {
    console.error(new Neo4jNotConfigured(["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"]).message);
    return 2;
  }

  const { records: totalRec } = await run(`MATCH (vc:ValueCluster) RETURN count(vc) AS total`);
  const total = toNum(totalRec[0]?.get("total"));

  const { records: bigRec } = await run(
    `MATCH (vc:ValueCluster)<-[:IN_CLUSTER]-(b:Belief)
     WITH vc, count(DISTINCT b) AS members
     WHERE members >= 2
     RETURN count(vc) AS clusters`,
  );
  const clustersWith2 = toNum(bigRec[0]?.get("clusters"));

  const { records: shareRec } = await run(`MATCH ()-[r:SHARES_VALUE]->() RETURN count(r) AS c`);
  const shares = toNum(shareRec[0]?.get("c"));

  const { records: badRec } = await run(
    `MATCH ()-[r:SHARES_VALUE]->() WHERE r.basis IS NULL OR r.basis = '' RETURN count(r) AS c`,
  );
  const shareNoBasis = toNum(badRec[0]?.get("c"));

  console.log(
    `values: ${total} ValueCluster(s), ${clustersWith2} with >=2 members; ` +
      `${shares} SHARES_VALUE edge(s), ${shareNoBasis} missing basis`,
  );

  let ok = true;
  if (clustersWith2 < 2) {
    console.error(`  ✗ need >=2 clusters of >=2 members, have ${clustersWith2}`);
    ok = false;
  }
  if (shareNoBasis > 0) {
    console.error(`  ✗ ${shareNoBasis} SHARES_VALUE edge(s) without basis`);
    ok = false;
  }

  if (!ok) {
    console.error("values: NOT MET");
    return 1;
  }
  console.log("values: MET — clusters present, every SHARES_VALUE carries basis");
  return 0;
}

main()
  .then(async (code) => {
    await close();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(`values: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    await close();
    process.exit(1);
  });
