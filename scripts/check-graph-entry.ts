/* Gate: the Step-0 drop-zone verification accepts the party's own export and rejects foreign lists.
 * Regression for GUEST_LIST_MISMATCH-on-own-file: the export carries pending/invited/duplicate rows,
 * so the ratio must be coverage of the BAKED list, never share-of-file.
 * Run: GUESTS_CSV="<luma export>" npx tsx scripts/check-graph-entry.ts
 */
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { verifyGuestList } from "../app/graph/verify";

const fail = (m: string): never => { console.error("FAIL:", m); process.exit(1); };

const csvPath = process.env.GUESTS_CSV;
if (!csvPath) { console.error("GuestsCsvMissing: set GUESTS_CSV"); process.exit(2); }

// Parse exactly like the browser does (papaparse, header: true).
const parsed = Papa.parse<Record<string, unknown>>(readFileSync(csvPath, "utf8"), { header: true, skipEmptyLines: true });
const fields = parsed.meta.fields ?? [];
const rows = parsed.data;

const meta = JSON.parse(readFileSync("public/graph/graph.json", "utf8")).meta;
const guestIds: string[] = meta.guestIds;
if (guestIds.length !== meta.stages.unique) fail(`guestIds ${guestIds.length} !== stages.unique ${meta.stages.unique}`);

// 1. The party's own export MUST verify, at full coverage.
const own = verifyGuestList(rows, fields, guestIds);
if (!own.ok) fail(`own export rejected: ${own.code} — ${own.message}`);
else if (own.ratio !== 1) fail(`own export coverage ${own.ratio} !== 1`);

// 2. A foreign guest list (same shape, different ids) MUST be rejected.
const foreign = rows.map((r, i) => ({ ...r, guest_id: `gst-foreign-${i}` }));
const rej = verifyGuestList(foreign, fields, guestIds);
if (rej.ok || rej.code !== "GUEST_LIST_MISMATCH") fail(`foreign list not rejected (got ${rej.ok ? "ok" : rej.code})`);

// 3. An approved-only re-export (312 rows, no pending/invited/dups) MUST still verify.
const knownSet = new Set(guestIds);
const seen = new Set<string>();
const approvedOnly = rows.filter((r) => {
  const id = String(r["guest_id"] ?? "").trim();
  if (!knownSet.has(id) || seen.has(id)) return false;
  seen.add(id);
  return true;
});
if (approvedOnly.length !== guestIds.length) fail(`approved-only subset ${approvedOnly.length} !== ${guestIds.length}`);
const sub = verifyGuestList(approvedOnly, fields, guestIds);
if (!sub.ok) fail(`approved-only re-export rejected: ${sub.code}`);

// 4. A partial list (75% of the room) MUST be rejected — the threshold still means something.
const partial = approvedOnly.slice(0, Math.floor(guestIds.length * 0.75));
const par = verifyGuestList(partial, fields, guestIds);
if (par.ok) fail("75%-coverage partial list wrongly accepted");

console.log(`entry gate OK: own export verifies at 100% (${rows.length} rows → ${guestIds.length} covered) · foreign rejected · approved-only accepted · partial rejected`);
