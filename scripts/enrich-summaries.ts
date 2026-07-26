// scripts/enrich-summaries.ts — run the summary pass over the real guest CSV.
//
// CSV → Guest[] → (cached, batched, guarded gateway pass) → data/graph-private/summaries.json:
// provenance at the top, one record per personId under `records`. The file is gitignored and
// exists so downstream legs read the pass instead of re-spending gateway calls.
//
// This is the SECOND register over the same four answers. `enrich-convictions.ts` writes what the
// guest STATED; this writes OUR read of them (`summary`) and OUR label (`inferred.mission` /
// `inferred.impact`), structurally separated so nothing here can be mistaken for something they
// said. It does NOT "fix" the conviction pass's nulls — most guests are still null on both.
//
//   set -a; source .env; set +a
//   GUESTS_CSV=… npx tsx scripts/enrich-summaries.ts
//   GUESTS_CSV=… GUESTS_FILTER=gst-a,gst-b SUMMARIES_JSON=/tmp/golden.json npx tsx scripts/…
//   SUMMARY_MODEL=anthropic/claude-sonnet-4.6 GUESTS_CSV=… npx tsx scripts/enrich-summaries.ts
//
// Env:
//   GUESTS_CSV     (required) path to the Luma guest export
//   GUESTS_FILTER  (optional) comma-separated guest_ids — the golden-sample run. DESTRUCTIVE:
//                  it narrows what gets WRITTEN, so always pair it with SUMMARIES_JSON.
//   SUMMARIES_JSON (optional) override data/graph-private/summaries.json (also the cache path)
//   SUMMARY_MODEL  (optional) override anthropic/claude-haiku-4.5
//   SUMMARY_BATCH  (optional) override the 20-guest batch
//
// Exit codes: 2 = DEGRADED (no gateway creds / no GUESTS_CSV) · 1 = the pass failed loud
// (nothing extracted, an unmatched filter id, or a named gateway error) · 0 = wrote the file.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadGuests } from "../lib/guests";
import { isGatewayConfigured, GatewayNotConfigured } from "../lib/gateway";
import {
  extractSummaries, summariesPath, summaryModel, summaryBatch,
  INFER_MIN_CONFIDENCE, MAX_QUOTE_WORDS, SUMMARY_GUARD_FAILED_FLAG,
} from "../lib/summarize";

function pct(n: number, total: number): string {
  return total ? `${((n / total) * 100).toFixed(1)}%` : "—";
}

function row(label: string, n: number, total: number): string {
  return `  ${label.padEnd(16)} ${String(n).padStart(4)}/${total}  ${pct(n, total)}`;
}

/** Confidence histogram in 0.1 bands — how strong the reads actually are, at a glance. */
function histogram(values: number[]): string {
  if (!values.length) return "  (none)";
  const bands = new Map<string, number>();
  for (const v of values) {
    const lo = Math.min(0.9, Math.floor(v * 10) / 10);
    const key = `${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}`;
    bands.set(key, (bands.get(key) ?? 0) + 1);
  }
  return [...bands.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([band, n]) => `  ${band.padEnd(16)} ${String(n).padStart(4)}  ${"█".repeat(Math.ceil((n / values.length) * 40))}`)
    .join("\n");
}

async function main(): Promise<void> {
  // DEGRADED — named error, exit 2. Never a fake pass.
  if (!isGatewayConfigured()) {
    console.error(
      "GatewayNotConfigured: BUTTERBASE_GATEWAY_URL / BUTTERBASE_API_KEY missing — " +
        "DEGRADED mode, summary extraction impossible.",
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
      // fail loud, same as the sibling legs: a golden run silently enriching 9/10 is the bug.
      console.error(`GuestsFilterUnmatched: ${unmatched.length} guest_id(s) not in the CSV — ${unmatched.join(", ")}`);
      process.exit(1);
    }
    if (!process.env.SUMMARIES_JSON?.trim()) {
      // GUESTS_FILTER narrows what gets WRITTEN. Without an override the golden run would replace
      // the full artifact with its 10 records and every other guest would look like a cache miss.
      console.error(
        `GuestsFilterWouldClobber: GUESTS_FILTER selects ${guests.length} guest(s) but SUMMARIES_JSON ` +
          `is unset — the run would overwrite ${summariesPath()} with a partial artifact. ` +
          `Set SUMMARIES_JSON to a scratch path for filtered runs.`,
      );
      process.exit(1);
    }
  }
  if (!guests.length) {
    console.error("NoGuestsSelected: the CSV (after GUESTS_FILTER) yielded 0 guests");
    process.exit(1);
  }

  const path = summariesPath();
  console.log(
    `summary pass: ${guests.length} guest(s) · model ${summaryModel()}` +
      `${process.env.SUMMARY_MODEL?.trim() ? " (SUMMARY_MODEL override)" : ""}` +
      ` · batch ${summaryBatch()} · quote cap ${MAX_QUOTE_WORDS}w · inference floor ${INFER_MIN_CONFIDENCE}` +
      `\n  → ${path}${process.env.SUMMARIES_JSON?.trim() ? " (SUMMARIES_JSON override)" : ""}`,
  );

  const res = await extractSummaries(guests, { path });

  // ---- tally BEFORE anything touches disk ----
  const all = guests.map((g) => res.artifact.records[g.personId]).filter((r) => r !== undefined);
  const total = all.length;
  const withSummary = all.filter((r) => r.summary !== null).length;
  const withMission = all.filter((r) => r.inferred.mission !== null).length;
  const withImpact = all.filter((r) => r.inferred.impact !== null).length;
  const withBoth = all.filter((r) => r.inferred.mission !== null && r.inferred.impact !== null).length;
  const flagged = guests.filter((g) => g.flags.includes(SUMMARY_GUARD_FAILED_FLAG));

  if (flagged.length) {
    console.error(
      `\n${SUMMARY_GUARD_FAILED_FLAG.toUpperCase()} (${flagged.length}/${total}): ` +
        flagged.map((g) => g.personId).join(", "),
    );
  }

  // ---- total-outage tripwire, BEFORE the write ----
  // An all-failed cache on disk is worse than no cache at all: downstream legs read this file
  // instead of re-spending gateway calls, so a dead-gateway run must leave NOTHING behind — not
  // the poisoned run, and not a stale file that would be mistaken for it. Scoped to the guests
  // that were actually ASKED (blank-answer guests are legitimately empty and must not mask an
  // outage) and to a run that served nothing from cache (cache hits are real, paid-for records).
  const askedFresh = res.askable - res.hits;
  if (askedFresh > 0 && res.failed === askedFresh && res.hits === 0) {
    console.error(
      `FAIL: every asked guest (${res.failed}/${askedFresh}) failed the guard — nothing was extracted. ` +
        `NOT writing ${path}.`,
    );
    if (existsSync(path)) {
      rmSync(path, { force: true });
      console.error(`removed the stale ${path} — no cache is better than a poisoned one.`);
    }
    process.exit(1);
  }

  // ---- write the artifact ----
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(res.artifact, null, 2)}\n`, "utf8");

  // ---- coverage table ----
  console.log(
    `\nwrote ${path} — ${total} record(s) · _src ${res.artifact._src} · _model ${res.artifact._model}` +
      `\n  ${res.extracted} extracted · ${res.hits} from cache · ${res.skipped} no-answers · ${res.failed} guard-failed` +
      `\ncoverage:`,
  );
  console.log(row("summary", withSummary, total));
  console.log(row("inferred mission", withMission, total));
  console.log(row("inferred impact", withImpact, total));
  console.log(row("both labels", withBoth, total));
  console.log(row("neither label", total - withMission - withImpact + withBoth, total));
  console.log(row(SUMMARY_GUARD_FAILED_FLAG, flagged.length, total));
  if (res.droppedInferences) {
    console.log(`  ${res.droppedInferences} label(s) dropped below the ${INFER_MIN_CONFIDENCE} confidence floor`);
  }
  if (res.droppedNoEvidence) {
    console.log(`  ${res.droppedNoEvidence} label(s) dropped for having no verifiable quote`);
  }
  if (res.tolerated) {
    console.log(`  ${res.tolerated} record(s) kept after the retry with named, tolerated violations`);
  }

  const sConf = all.map((r) => r.summary?.confidence).filter((c): c is number => typeof c === "number");
  const iConf = all.flatMap((r) => [r.inferred.mission?.confidence, r.inferred.impact?.confidence])
    .filter((c): c is number => typeof c === "number");
  console.log(`\nsummary confidence (n=${sConf.length}):\n${histogram(sConf)}`);
  console.log(`\ninference confidence (n=${iConf.length}):\n${histogram(iConf)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (e instanceof GatewayNotConfigured) {
      console.error("enrich-summaries DEGRADED —", e.message);
      process.exit(2);
    }
    console.error("enrich-summaries FAILED —", e);
    process.exit(1);
  });
