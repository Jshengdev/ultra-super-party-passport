// Deterministic value clusters from the precache's ground-truth family assignment.
// The enrichment CREATED the belief structure; the LLM needn't rediscover it (rule 7).
import { readFileSync } from "fs";
import Papa from "papaparse";
import { dispatch } from "@/lib/ontology-gate";
import { run } from "@/lib/neo4j";

const CSV_PATH = process.env.CSV_PATH || "data/party.csv";
const TITLES: Record<string, string> = {
  "maker-builders": "The Maker-Builders",
  "storytellers": "The Storytellers",
  "world-changers": "The World-Changers",
  "aesthetes": "The Aesthetes",
  "systems-minds": "The Systems Minds",
  "community-weavers": "The Community Weavers",
};
const arch = JSON.parse(readFileSync("data/archetypes.json", "utf8"));
const themes = new Map<string, string>(arch.families.map((f: { family: string; belief_theme: string }) => [f.family, f.belief_theme]));

async function main() {
  const rows = Papa.parse<Record<string, string>>(readFileSync(CSV_PATH, "utf8"), { header: true, skipEmptyLines: true }).data;
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const fam = r.family; // precache v3 ground truth
    if (!fam) continue;
    const slug = r.email.split("@")[0];
    groups.set(fam, [...(groups.get(fam) ?? []), slug]);
  }
  // clear prior value-cluster layer (maintenance op, pre-rewrite)
  await run("MATCH ()-[r:SHARES_VALUE]->() DELETE r");
  await run("MATCH (c:ValueCluster) DETACH DELETE c");
  let i = 0;
  for (const [fam, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    i++;
    await dispatch("write_value_cluster", {
      cluster: { id: `cluster-${i}`, name: TITLES[fam] ?? fam, basis: themes.get(fam) ?? fam },
      members: members.map((personId) => ({ personId })),
    }, { src: "precache:family", actor: "pipeline" });
    console.log(`cluster-${i} ${TITLES[fam] ?? fam}: ${members.length} members`);
  }

}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
