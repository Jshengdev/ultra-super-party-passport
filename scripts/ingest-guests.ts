/**
 * scripts/ingest-guests.ts — the real-party ingest leg: guest CSV → the ontology gate.
 *
 * Beyond the v2 place/inspiration edges it also lands the v1 SHAPE the original product reads —
 * Belief+BELIEVES (→ clustering → SHARES_VALUE) and Activity+DOES/WORKING_ON (→ same-work
 * passport paths) — see v1Shape() below for the field mapping.
 *
 * Every write goes through `dispatch("ingest_guest_v2", …)` (CLAUDE.md law a) — there is
 * zero raw write-Cypher here; the only direct `run()` is the read-only Person count at the
 * end. Provenance {src:"csv:la-intern-party", actor:"pipeline"} rides every dispatch (law d).
 *
 * DEGRADED law (b): no NEO4J_* → print the NAMED Neo4jNotConfigured error, exit 2. No
 * GUESTS_CSV → GuestsCsvMissing, exit 2. Per-guest errors are collected, printed in full,
 * and exit 1 — never swallowed, never a silent partial success.
 *
 * Env:
 *   GUESTS_CSV     (required) path to the Luma guest export
 *   GUESTS_FILTER  (optional) comma-separated guest_ids — the golden-sample run
 *   DRY_RUN=1      (optional) print the exact dispatch params for the first 3 selected
 *                  guests as JSONL on stdout, validate ALL selected guests against the
 *                  manifest's IngestGuestV2Params, and exit without touching the driver
 */
import { loadGuests, type Guest } from "../lib/guests";
import { dispatch } from "../lib/ontology-gate";
import { isConfigured, run, toNum, close, Neo4jNotConfigured } from "../lib/neo4j";
import { DEFAULT_PARTY, IngestGuestV2Params } from "../ontology/manifest";

const PROV = { src: "csv:la-intern-party", actor: "pipeline" } as const;

/**
 * Hometown → Place. Known cities get real coords (the universe can place them); everything
 * else lands at 0/0 with the name preserved, which is honest rather than invented.
 * `as` is the canonical display name so "LA" and "Los Angeles" MERGE onto one Place node.
 */
const CITY: Record<string, { lat: number; lng: number; as?: string }> = {
  "los angeles": { lat: 34.05, lng: -118.24 },
  la: { lat: 34.05, lng: -118.24, as: "Los Angeles" },
  atlanta: { lat: 33.75, lng: -84.39 },
  "new york": { lat: 40.71, lng: -74.01 },
  nyc: { lat: 40.71, lng: -74.01, as: "New York" },
  "san francisco": { lat: 37.77, lng: -122.42 },
  sf: { lat: 37.77, lng: -122.42, as: "San Francisco" },
  "san diego": { lat: 32.72, lng: -117.16 },
  houston: { lat: 29.76, lng: -95.37 },
  philadelphia: { lat: 39.95, lng: -75.17 },
  irvine: { lat: 33.68, lng: -117.83 },
  "long beach": { lat: 33.77, lng: -118.19 },
  "orange county": { lat: 33.72, lng: -117.83 },
  denver: { lat: 39.74, lng: -104.99 },
  miami: { lat: 25.76, lng: -80.19 },
  seattle: { lat: 47.61, lng: -122.33 },
  chicago: { lat: 41.88, lng: -87.63 },
};

function place(hometown: string | null): { name: string; lat: number; lng: number } | null {
  if (!hometown) return null;
  // "Los Angeles, CA" / "LA/NYC" → the leading locality; state + secondary cities dropped so
  // the same city from two writers MERGEs onto one node.
  const head = hometown.split(/[\/,]/)[0].trim();
  if (!head) return null; // punctuation-only hometown — a Place {name:""} would fail the gate
  const c = CITY[head.toLowerCase()];
  if (c) return { name: c.as ?? head, lat: c.lat, lng: c.lng };
  return { name: head.slice(0, 40).trim(), lat: 0, lng: 0 };
}

/**
 * The v1 graph shape the ORIGINAL surfaces read, mapped out of the v2 guest answers:
 *   belief     → what drew them to the industry (falls back to their goal) — the text
 *                lib/cluster.ts embeds into ValueClusters, so SHARES_VALUE/passport
 *                values-paths exist for these guests too.
 *   does       → job title, LOWERCASED (ingest_person's normActivity convention) so two
 *                guests who both wrote "Director" MERGE onto one Activity node.
 *   workingOn  → their stated goal, case preserved (ingest_person's convention).
 * Empty answers map to null / [] — never a Belief{text:""} or an Activity{name:""}.
 */
function v1Shape(g: Guest): { belief: string | null; does: string[]; workingOn: string[] } {
  return {
    belief: g.answers.drew || g.answers.goal || null,
    does: g.title ? [g.title.toLowerCase()] : [],
    workingOn: g.answers.goal ? [g.answers.goal] : [],
  };
}

/** The exact params object handed to the gate — shared by the live path and DRY_RUN. */
function paramsFor(g: Guest) {
  return {
    person: { id: g.personId, name: g.name, position: g.title },
    school: g.school,
    company: g.company,
    place: place(g.hometown),
    inspiration: g.answers.inspiration ? g.answers.inspiration.slice(0, 80) : null,
    ...v1Shape(g),
    party: DEFAULT_PARTY,
  };
}

async function main(): Promise<number> {
  const dryRun = process.env.DRY_RUN === "1";

  if (!dryRun && !isConfigured()) {
    const missing = ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"].filter((k) => !process.env[k]);
    console.error(new Neo4jNotConfigured(missing).message);
    return 2;
  }
  const csv = process.env.GUESTS_CSV;
  if (!csv) {
    console.error("GuestsCsvMissing: set GUESTS_CSV to the guest export path");
    return 2;
  }

  let guests = loadGuests(csv);
  const total = guests.length;

  const filter = process.env.GUESTS_FILTER?.split(",").map((s) => s.trim()).filter(Boolean);
  if (filter?.length) {
    guests = guests.filter((g) => filter.includes(g.guestId));
    const found = new Set(guests.map((g) => g.guestId));
    const unmatched = filter.filter((id) => !found.has(id));
    if (unmatched.length) {
      // fail loud: a golden run silently ingesting 9/10 is exactly the bug this guards
      console.error(`GuestsFilterUnmatched: ${unmatched.length} guest_id(s) not in the CSV — ${unmatched.join(", ")}`);
      return 1;
    }
  }
  if (!guests.length) {
    console.error(`NoGuestsSelected: 0 of ${total} guests selected (check GUESTS_FILTER)`);
    return 1;
  }

  if (dryRun) {
    for (const g of guests.slice(0, 3)) console.log(JSON.stringify(paramsFor(g)));
    // Same zod the gate will run, minus the driver: proves the whole selection is
    // representable before a single write is attempted.
    const invalid: string[] = [];
    for (const g of guests) {
      const parsed = IngestGuestV2Params.safeParse(paramsFor(g));
      if (!parsed.success) {
        invalid.push(`${g.personId} (${g.guestId}): ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
      }
    }
    console.error(
      `DRY_RUN: ${guests.length} guest(s) selected of ${total}; printed ${Math.min(3, guests.length)}; ` +
        `${guests.length - invalid.length}/${guests.length} valid against IngestGuestV2Params; driver untouched.`,
    );
    if (invalid.length) {
      console.error(`INVALID (${invalid.length}):\n${invalid.join("\n")}`);
      return 1;
    }
    return 0;
  }

  const failures: string[] = [];
  let ok = 0;
  for (const g of guests) {
    try {
      await dispatch("ingest_guest_v2", paramsFor(g), PROV);
      ok++;
      if (ok % 50 === 0) console.log(`  …${ok}/${guests.length}`);
    } catch (e) {
      failures.push(`${g.personId} (${g.guestId}): ${(e as Error).message}`);
    }
  }

  try {
    const res = await run("MATCH (p:Person) RETURN count(p) AS n", {});
    const inGraph = toNum(res.records[0].get("n"));
    console.log(`ingested ${ok}/${guests.length}; Person count in graph (all sources): ${inGraph}`);
  } catch (e) {
    console.log(`ingested ${ok}/${guests.length}`);
    failures.push(`count-query: ${(e as Error).message}`);
  }

  if (failures.length) {
    console.error(`FAILURES (${failures.length}):\n${failures.join("\n")}`);
    return 1;
  }
  return 0;
}

main()
  .then(async (code) => {
    await close();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(`ingest-guests FAILED: ${(e as Error).name}: ${(e as Error).message}`);
    await close();
    process.exit(1);
  });
