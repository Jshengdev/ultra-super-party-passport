// Flip every approved guest to checked-in THROUGH THE GATE (152 typed kinetic actions).
import { readFileSync } from "fs";
import Papa from "papaparse";
import { dispatch } from "@/lib/ontology-gate";
import { DEFAULT_PARTY } from "@/ontology/manifest";

const CSV_PATH = process.env.CSV_PATH || "data/party.csv";
async function main() {
  const rows = Papa.parse<Record<string, string>>(readFileSync(CSV_PATH, "utf8"), { header: true, skipEmptyLines: true }).data;
  let n = 0;
  for (const r of rows) {
    if ((r.status || "").toLowerCase() !== "approved") continue;
    const slug = r.email.split("@")[0];
    await dispatch("check_in", { personId: slug, partyId: DEFAULT_PARTY.id, checkedIn: true }, { src: "csv:status-approved", actor: "pipeline" });
    n++;
  }
  console.log(`checkin-approved: ${n} guests checked in through the gate`);

}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
