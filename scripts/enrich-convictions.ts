// scripts/enrich-convictions.ts — run the conviction pass over the real guest CSV.
//
// CSV → Guest[] → (batched, guarded gateway pass) → data/graph-private/convictions.json,
// keyed by personId. The file is gitignored and exists so downstream tasks (matches,
// passports) read the pass instead of re-spending gateway calls.
//
// PROVENANCE IS WRITTEN HERE, NOT INFERRED LATER (law d). The model is resolved ONCE, handed to
// the pass, and stamped on the artifact as `_model`, so the file itself answers "which model
// tagged these people". Downstream (scripts/emit-graph.ts's `extraction_model` sheet column)
// ECHOES that string and never re-reads `CONVICTION_MODEL` — an env var read at emit time
// attests the model that would run NOW, which is a different claim, and was wrong for the whole
// standing bake. Same pattern as lib/summarize.ts.
//
//   node --env-file=.env --import tsx scripts/enrich-convictions.ts
//   GUESTS_CSV=… GUESTS_FILTER=gst-a,gst-b  node --env-file=.env --import tsx scripts/enrich-convictions.ts
//   CONVICTION_MODEL=anthropic/claude-haiku-4.5  node --env-file=.env --import tsx scripts/…
//
// Exit codes: 2 = DEGRADED (no gateway creds / no GUESTS_CSV) · 1 = the pass failed
// loud (nothing extracted, or a named gateway error) · 0 = wrote the file.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadGuests } from "../lib/guests";
import { isGatewayConfigured, GatewayNotConfigured } from "../lib/gateway";
import {
  extractConvictions, convictionModel, CONVICTIONS_PATH, CONVICTION_SRC, GUARD_FAILED_FLAG,
  MAX_QUOTE_WORDS, type Conviction, type ConvictionsArtifact,
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
    const found = new Set(guests.map((g) => g.guestId));
    const unmatched = filter.filter((id) => !found.has(id));
    if (unmatched.length) {
      // fail loud, same as the sibling ingest: a golden run silently enriching 9/10 is the bug.
      console.error(`GuestsFilterUnmatched: ${unmatched.length} guest_id(s) not in the CSV — ${unmatched.join(", ")}`);
      process.exit(1);
    }
  }
  if (!guests.length) {
    console.error("NoGuestsSelected: the CSV (after GUESTS_FILTER) yielded 0 guests");
    process.exit(1);
  }
  // Resolved ONCE: this exact string runs every batch AND is what the artifact attests below.
  const model = convictionModel();
  console.log(
    `conviction pass: ${guests.length} guest(s) · model ${model}` +
      `${process.env.CONVICTION_MODEL?.trim() ? " (CONVICTION_MODEL override)" : ""}` +
      ` · quote cap ${MAX_QUOTE_WORDS}w`,
  );

  const conv = await extractConvictions(guests, { model });

  // ---- tally BEFORE anything touches disk ----
  const record: Record<string, Conviction> = {};
  for (const g of guests) {
    const c = conv.get(g.personId);
    if (c) record[g.personId] = c;
  }
  const all = Object.values(record);
  const total = all.length;
  const nn = (k: "motive" | "mission" | "impact" | "aspiration") => all.filter((c) => c[k] !== null).length;
  const guardFailed = guests.filter((g) => g.flags.includes(GUARD_FAILED_FLAG));
  const quoted = all.filter((c) => Object.keys(c.quotes).length > 0).length;
  const openSeekers = all.filter((c) => c.openSeeker).length;

  if (guardFailed.length) {
    console.error(
      `\n${GUARD_FAILED_FLAG.toUpperCase()} (${guardFailed.length}/${total}): ` +
        guardFailed.map((g) => g.personId).join(", "),
    );
  }

  // ---- total-outage tripwire, BEFORE the write ----
  // An all-null cache on disk is worse than no cache at all: downstream tasks read this file
  // instead of re-spending gateway calls, so a dead-gateway run must leave NOTHING behind —
  // not the poisoned run, and not a stale file that would be mistaken for it.
  if (total > 0 && guardFailed.length === total) {
    console.error(
      `FAIL: every guest (${total}/${total}) failed the guard — nothing was extracted. ` +
        `NOT writing ${CONVICTIONS_PATH}.`,
    );
    if (existsSync(CONVICTIONS_PATH)) {
      rmSync(CONVICTIONS_PATH, { force: true });
      console.error(`removed the stale ${CONVICTIONS_PATH} — no cache is better than a poisoned one.`);
    }
    process.exit(1);
  }

  // ---- write the artifact: provenance at the top, records nested under `convictions` ----
  // Nested rather than flat-at-root so `Object.entries()` over the file can never hand a reader
  // the `_model` string where a Conviction is expected (the reason lib/summarize.ts nests too).
  // Readers go through `convictionsOf`, which still accepts the legacy flat file.
  const artifact: ConvictionsArtifact = {
    _src: CONVICTION_SRC,
    _model: model,
    _ts: new Date().toISOString(),
    _actor: "agent",
    convictions: record,
  };
  mkdirSync(dirname(CONVICTIONS_PATH), { recursive: true });
  writeFileSync(CONVICTIONS_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  // ---- coverage table ----
  console.log(`\nwrote ${CONVICTIONS_PATH} — ${total} record(s) · _model ${model}\ncoverage:`);
  for (const k of ["motive", "mission", "impact", "aspiration"] as const) {
    console.log(`  ${k.padEnd(11)} ${String(nn(k)).padStart(4)}/${total}  ${pct(nn(k), total)}`);
  }
  console.log(`  ${"with quotes".padEnd(11)} ${String(quoted).padStart(4)}/${total}  ${pct(quoted, total)}`);
  console.log(`  ${"openSeeker".padEnd(11)} ${String(openSeekers).padStart(4)}/${total}  ${pct(openSeekers, total)}`);
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
