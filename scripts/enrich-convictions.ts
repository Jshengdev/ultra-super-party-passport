// scripts/enrich-convictions.ts — run the conviction pass over the real guest CSV.
//
// CSV → Guest[] → (batched, guarded gateway pass) → data/graph-private/convictions.json,
// keyed by personId. The file is gitignored and exists so downstream tasks (matches,
// passports) read the pass instead of re-spending gateway calls.
//
//   node --env-file=.env --import tsx scripts/enrich-convictions.ts
//   GUESTS_CSV=… GUESTS_FILTER=gst-a,gst-b  node --env-file=.env --import tsx scripts/enrich-convictions.ts
//   CONVICTION_MODEL=anthropic/claude-haiku-4.5  node --env-file=.env --import tsx scripts/…
//
// Exit codes: 2 = DEGRADED (no gateway creds / no GUESTS_CSV) · 1 = the pass failed
// loud (nothing extracted, or a named gateway error) · 0 = wrote the file.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadGuests } from "../lib/guests";
import { isGatewayConfigured, GatewayNotConfigured } from "../lib/gateway";
import {
  extractConvictions, convictionModel, CONVICTIONS_PATH, GUARD_FAILED_FLAG, MAX_QUOTE_WORDS,
  type Conviction,
} from "../lib/conviction";

function pct(n: number, total: number): string {
  return total ? `${((n / total) * 100).toFixed(1)}%` : "—";
}

async function main(): Promise<void> {
  // DEGRADED — named error, exit 2. Never a fake pass.
  if (!isGatewayConfigured()) {
    console.error(
      "GatewayNotConfigured: BUTTERBASE_GATEWAY_URL / BUTTERBASE_API_KEY missing — " +
        "DEGRADED mode, conviction extraction impossible.",
    );
    process.exit(2);
  }
  const csv = process.env.GUESTS_CSV;
  if (!csv) {
    console.error("GuestsCsvMissing: set GUESTS_CSV");
    process.exit(2);
  }

  let guests = loadGuests(csv);
  const filter = process.env.GUESTS_FILTER?.split(",").map((s) => s.trim()).filter(Boolean);
  if (filter?.length) {
    guests = guests.filter((g) => filter.includes(g.guestId));
    const missing = filter.filter((id) => !guests.some((g) => g.guestId === id));
    if (missing.length) console.error(`GUESTS_FILTER: ${missing.length} id(s) not in the CSV — ${missing.join(", ")}`);
  }
  if (!guests.length) {
    console.error("NoGuestsSelected: the CSV (after GUESTS_FILTER) yielded 0 guests");
    process.exit(1);
  }
  console.log(
    `conviction pass: ${guests.length} guest(s) · model ${convictionModel()}` +
      `${process.env.CONVICTION_MODEL?.trim() ? " (CONVICTION_MODEL override)" : ""}` +
      ` · quote cap ${MAX_QUOTE_WORDS}w`,
  );

  const conv = await extractConvictions(guests);

  // ---- write the artifact (flat: { [personId]: Conviction }) ----
  const record: Record<string, Conviction> = {};
  for (const g of guests) {
    const c = conv.get(g.personId);
    if (c) record[g.personId] = c;
  }
  mkdirSync(dirname(CONVICTIONS_PATH), { recursive: true });
  writeFileSync(CONVICTIONS_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  // ---- coverage table ----
  const all = Object.values(record);
  const total = all.length;
  const nn = (k: "motive" | "mission" | "impact" | "aspiration") => all.filter((c) => c[k] !== null).length;
  const guardFailed = guests.filter((g) => g.flags.includes(GUARD_FAILED_FLAG));
  const quoted = all.filter((c) => Object.keys(c.quotes).length > 0).length;
  const openSeekers = all.filter((c) => c.openSeeker).length;

  console.log(`\nwrote ${CONVICTIONS_PATH} — ${total} record(s)\ncoverage:`);
  for (const k of ["motive", "mission", "impact", "aspiration"] as const) {
    console.log(`  ${k.padEnd(11)} ${String(nn(k)).padStart(4)}/${total}  ${pct(nn(k), total)}`);
  }
  console.log(`  ${"with quotes".padEnd(11)} ${String(quoted).padStart(4)}/${total}  ${pct(quoted, total)}`);
  console.log(`  ${"openSeeker".padEnd(11)} ${String(openSeekers).padStart(4)}/${total}  ${pct(openSeekers, total)}`);

  if (guardFailed.length) {
    console.error(
      `\n${GUARD_FAILED_FLAG.toUpperCase()} (${guardFailed.length}/${total}): ` +
        guardFailed.map((g) => g.personId).join(", "),
    );
  }
  if (total > 0 && guardFailed.length === total) {
    console.error("FAIL: every guest failed the guard — nothing was extracted.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (e instanceof GatewayNotConfigured) {
      console.error("enrich-convictions DEGRADED —", e.message);
      process.exit(2);
    }
    console.error("enrich-convictions FAILED —", e);
    process.exit(1);
  });
