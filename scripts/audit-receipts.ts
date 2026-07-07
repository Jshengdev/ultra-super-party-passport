// scripts/audit-receipts.ts — THE TEETH.
// For every passport JSON: verify every path_receipt edge EXISTS in Neo4j (parameterized existence query)
// and every find.personId exists. ANY unreceipted claim → print it and exit 1 (dot grounded-counts law).
//
// Run with env loaded, e.g.:  node --env-file=.env ./node_modules/.bin/tsx scripts/audit-receipts.ts

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runRead, closeDriver } from "@/lib/traverse";
import { passportSchema } from "@/passport/schema";

const DIR = path.resolve(process.cwd(), "data/passports");

async function edgeExists(from: string, rel: string, to: string): Promise<boolean> {
  const rows = await runRead<{ ok: boolean }>(
    `
    MATCH (a)-[r]->(b)
    WHERE (a.name = $from OR a.id = $from) AND (b.name = $to OR b.id = $to) AND type(r) = $rel
    RETURN count(r) > 0 AS ok
    `,
    { from, to, rel },
  );
  return rows.length > 0 ? Boolean(rows[0].ok) : false;
}

async function personExists(id: string): Promise<boolean> {
  const rows = await runRead<{ ok: boolean }>(
    `MATCH (p:Person) WHERE p.id = $id OR p.name = $id RETURN count(p) > 0 AS ok`,
    { id },
  );
  return rows.length > 0 ? Boolean(rows[0].ok) : false;
}

async function main(): Promise<void> {
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
  } catch {
    /* .env absent — runRead() will fail loud if Neo4j creds are actually missing */
  }

  let files: string[];
  try {
    files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`[audit] no passports directory at ${DIR} — generate passports first (fail-loud).`);
    process.exitCode = 1;
    return;
  }
  if (files.length === 0) {
    console.error("[audit] no passport JSON files to audit (fail-loud).");
    process.exitCode = 1;
    return;
  }

  const violations: string[] = [];
  let edgesChecked = 0;
  let targetsChecked = 0;

  for (const file of files) {
    const raw = await readFile(path.join(DIR, file), "utf8");
    let passport;
    try {
      passport = passportSchema.parse(JSON.parse(raw));
    } catch (e) {
      violations.push(`${file}: not a valid passport JSON — ${(e as Error).message}`);
      continue;
    }
    for (const find of passport.find) {
      targetsChecked++;
      if (!(await personExists(find.personId))) {
        violations.push(`${file}: find.personId "${find.personId}" (${find.name}) does not exist in Neo4j`);
      }
      for (const edge of find.path_receipt) {
        edgesChecked++;
        if (!(await edgeExists(edge.from, edge.rel, edge.to))) {
          violations.push(
            `${file}: UNRECEIPTED edge (${edge.from})-[:${edge.rel}]->(${edge.to}) — no such edge in Neo4j`,
          );
        }
      }
    }
  }

  console.log(
    `[audit] ${files.length} passports · ${edgesChecked} receipt edges · ${targetsChecked} find-targets checked.`,
  );
  if (violations.length > 0) {
    console.error(`[audit] ✗ ${violations.length} UNRECEIPTED CLAIM(S) — the teeth bite:`);
    for (const v of violations) console.error(`   - ${v}`);
    process.exitCode = 1;
    return;
  }
  console.log("[audit] ✓ every path_receipt edge and every find.personId exists in Neo4j. All claims grounded.");
}

main()
  .catch((e) => {
    console.error("[audit] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
