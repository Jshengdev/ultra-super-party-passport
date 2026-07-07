/**
 * scripts/check-checkin.ts — G5 gate. Proves the kinetic layer works end to end.
 *
 * Picks a real SIGNED_UP person, dispatches check_in to flip their state through the
 * gate, reads it back, asserts the flip, then reverts to the original state and
 * re-asserts. A non-mutating round trip — the graph is left exactly as found.
 *
 * exit 0 = flip works · exit 1 = failed / nothing to test · exit 2 = not configured.
 */
import { run, isConfigured, close, Neo4jNotConfigured } from "@/lib/neo4j";
import { dispatch } from "@/lib/ontology-gate";

async function readState(personId: string, partyId: string): Promise<boolean> {
  const { records } = await run(
    `MATCH (:Person {id: $personId})-[su:SIGNED_UP]->(:Party {id: $partyId}) RETURN su.checked_in AS c`,
    { personId, partyId },
  );
  return Boolean(records[0]?.get("c"));
}

async function main(): Promise<number> {
  if (!isConfigured()) {
    console.error(new Neo4jNotConfigured(["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"]).message);
    return 2;
  }

  const { records } = await run(
    `MATCH (p:Person)-[su:SIGNED_UP]->(party:Party)
     RETURN p.id AS personId, party.id AS partyId, su.checked_in AS checkedIn
     ORDER BY p.id LIMIT 1`,
  );
  if (records.length === 0) {
    console.error("checkin: no SIGNED_UP person to test — run ingest first");
    return 1;
  }
  const personId = String(records[0].get("personId"));
  const partyId = String(records[0].get("partyId"));
  const original = Boolean(records[0].get("checkedIn"));
  const target = !original;

  await dispatch("check_in", { personId, partyId, checkedIn: target }, {
    src: "action:check_in",
    actor: "agent",
  });
  const flipped = await readState(personId, partyId);
  if (flipped !== target) {
    console.error(`  ✗ flip failed: ${personId} expected ${target}, read ${flipped}`);
    // best-effort restore before bailing
    await dispatch("check_in", { personId, partyId, checkedIn: original }, { actor: "agent" });
    return 1;
  }

  await dispatch("check_in", { personId, partyId, checkedIn: original }, {
    src: "action:check_in",
    actor: "agent",
  });
  const reverted = await readState(personId, partyId);
  if (reverted !== original) {
    console.error(`  ✗ revert failed: ${personId} expected ${original}, read ${reverted}`);
    return 1;
  }

  console.log(
    `checkin: MET — flipped ${personId} ${original} -> ${target} -> ${original} through the gate`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await close();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(`checkin: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    await close();
    process.exit(1);
  });
