// scripts/generate-passports.ts — build a passport for every person into data/passports/<id>.json.
// Small concurrency pool. FAIL-LOUD: a guard/receipt failure for a person is reported (never silently
// skipped); the batch finishes so ALL failures surface at once, then the process exits nonzero if any failed.
//
// Run with env loaded, e.g.:  node --env-file=.env ./node_modules/.bin/tsx scripts/generate-passports.ts
// (the script also best-effort loads ./.env via Node's process.loadEnvFile).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { allPeople, closeDriver } from "@/lib/traverse";
import { run } from "@/lib/neo4j";
import { buildPassport } from "@/lib/passport";

const OUT_DIR = path.resolve(process.cwd(), "data/passports");
const CONCURRENCY = Number(process.env.PASSPORT_CONCURRENCY || 4);

async function main(): Promise<void> {
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
  } catch {
    /* .env absent — getDriver()/gateway will fail loud if creds are actually missing */
  }

  await mkdir(OUT_DIR, { recursive: true });

  let people = await allPeople();
  if (process.env.PEOPLE_FILTER) {
    const want = new Set(process.env.PEOPLE_FILTER.split(",").map((x) => x.trim()));
    people = people.filter((p) => want.has(p.id));
    console.log(`[generate-passports] PEOPLE_FILTER: ${people.length} selected`);
  }
  if (process.env.GOING_ONLY === '1') {
    const { records } = await run("MATCH (p:Person)-[su:SIGNED_UP]->(:Party) WHERE su.checked_in = true RETURN p.id AS id");
    const going = new Set(records.map((r) => String(r.get('id'))));
    people = people.filter((p) => going.has(p.id));
    console.log(`[generate-passports] GOING_ONLY: ${people.length} checked-in guests get passports`);
  }
  if (people.length === 0) {
    console.error("[generate-passports] No Person nodes in the graph — run ingest first (fail-loud).");
    process.exitCode = 1;
    return;
  }
  console.log(`[generate-passports] building ${people.length} passports (concurrency ${CONCURRENCY})…`);

  const failures: { id: string; name: string; error: string }[] = [];
  let ok = 0;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < people.length) {
      const p = people[idx++];
      try {
        const passport = await buildPassport(p.id);
        await writeFile(path.join(OUT_DIR, `${p.id}.json`), JSON.stringify(passport, null, 2), "utf8");
        ok++;
        console.log(`  ✓ ${p.id}  ${p.name}`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        failures.push({ id: p.id, name: p.name, error });
        console.error(`  ✗ ${p.id}  ${p.name} — ${error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, people.length) }, () => worker()));

  console.log(`[generate-passports] done: ${ok} ok, ${failures.length} failed → ${OUT_DIR}`);
  if (failures.length > 0) {
    console.error(`[generate-passports] FAILED LOUDLY for ${failures.length} people (no silent skips):`);
    for (const f of failures) console.error(`   - ${f.id} ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("[generate-passports] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
