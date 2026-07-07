/**
 * scripts/check-conformance.ts — G4 gate. Proves the graph is ontology-clean.
 *
 *   • every label in the DB is a manifest object type       (0 off-ontology labels)
 *   • every relationship type is a manifest link            (0 off-ontology rels)
 *   • every node carries _src AND _ts                        (0 unreceipted nodes)
 *   • every relationship carries _src AND _ts                (0 unreceipted rels)
 *
 * exit 0 = clean · exit 1 = violations found · exit 2 = Neo4j not configured (degraded).
 */
import { run, isConfigured, close, toNum, Neo4jNotConfigured } from "@/lib/neo4j";
import { OBJECT_TYPES, REL_TYPES } from "@/ontology/manifest";

async function main(): Promise<number> {
  if (!isConfigured()) {
    console.error(new Neo4jNotConfigured(["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"]).message);
    return 2;
  }

  const allowedLabels = new Set<string>(OBJECT_TYPES);
  const allowedRels = new Set<string>(REL_TYPES);

  const { records: labelRecs } = await run(`CALL db.labels() YIELD label RETURN label`);
  const labels = labelRecs.map((r) => String(r.get("label")));
  const badLabels = labels.filter((l) => !allowedLabels.has(l));

  const { records: relRecs } = await run(
    `CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType`,
  );
  const rels = relRecs.map((r) => String(r.get("relationshipType")));
  const badRels = rels.filter((r) => !allowedRels.has(r));

  const { records: nRec } = await run(
    `MATCH (n) WHERE n._src IS NULL OR n._ts IS NULL RETURN count(n) AS c`,
  );
  const nodesMissing = toNum(nRec[0]?.get("c"));

  const { records: rRec } = await run(
    `MATCH ()-[r]->() WHERE r._src IS NULL OR r._ts IS NULL RETURN count(r) AS c`,
  );
  const relsMissing = toNum(rRec[0]?.get("c"));

  console.log(`conformance: labels=[${labels.join(", ")}]`);
  console.log(`conformance: relationshipTypes=[${rels.join(", ")}]`);

  let violations = 0;
  if (badLabels.length) {
    console.error(`  ✗ OFF-ONTOLOGY LABELS: ${badLabels.join(", ")}`);
    violations++;
  }
  if (badRels.length) {
    console.error(`  ✗ OFF-ONTOLOGY REL TYPES: ${badRels.join(", ")}`);
    violations++;
  }
  if (nodesMissing > 0) {
    console.error(`  ✗ NODES MISSING PROVENANCE (_src/_ts): ${nodesMissing}`);
    violations++;
  }
  if (relsMissing > 0) {
    console.error(`  ✗ RELS MISSING PROVENANCE (_src/_ts): ${relsMissing}`);
    violations++;
  }

  if (violations > 0) {
    console.error(`conformance: ${violations} violation type(s) — NOT MET`);
    return 1;
  }
  console.log("conformance: CLEAN — all labels/rels on-ontology, all writes receipted");
  return 0;
}

main()
  .then(async (code) => {
    await close();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(`conformance: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    await close();
    process.exit(1);
  });
