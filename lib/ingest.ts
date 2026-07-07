/**
 * lib/ingest.ts — CSV → ingest_person actions.
 *
 * Papaparse the party CSV, normalize each row into ingest_person params, and dispatch
 * every write through the ontology gate (never raw Cypher). One person = one idempotent
 * transaction that MERGEs the Person, their School/Major/Activities/Belief, and their
 * SIGNED_UP edge to the party.
 */
import Papa from "papaparse";
import { dispatch } from "@/lib/ontology-gate";
import { DEFAULT_PARTY, type IngestPersonParams } from "@/ontology/manifest";

export interface CsvRow {
  name: string;
  email: string;
  school: string;
  major: string;
  what_you_do: string;
  working_on: string;
  instagram: string;
  x_handle: string;
  belief_creative: string;
  grad_year?: string;
  position?: string;
  company?: string;
  family?: string;
  status?: string;
}

/** trim + collapse internal whitespace, preserve case (for readable Activity/working_on) */
function clean(s: string | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ");
}

/** normalize an activity for SHARING: lowercased so "Filmmaker"/"filmmaker" MERGE as one */
function normActivity(s: string | undefined): string {
  return clean(s).toLowerCase();
}

/** deterministic person id from the (unique) email localpart */
export function personIdFor(email: string): string {
  return email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseCsv(text: string): CsvRow[] {
  const res = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (res.errors.length) {
    // Fail loud: surface parse errors rather than ingesting a truncated file silently.
    const sample = res.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join(" | ");
    throw new Error(`parseCsv: ${res.errors.length} CSV error(s) — ${sample}`);
  }
  return res.data.filter((r) => r.email?.trim() && r.name?.trim());
}

export function rowToParams(row: CsvRow): IngestPersonParams {
  const instagram = clean(row.instagram) || null;
  const x = clean(row.x_handle) || null;
  return {
    person: {
      id: personIdFor(row.email),
      name: clean(row.name),
      email: row.email.trim(),
      grad_year: row.grad_year ?? "",
      position: row.position ?? "",
      handles: JSON.stringify({ instagram, x }),
    },
    school: clean(row.school) || null,
    major: clean(row.major) || null,
    company: (row.company || "").trim() || null, // no company column in the CSV; WORKS_AT stays available but unpopulated
    does: clean(row.what_you_do) ? [normActivity(row.what_you_do)] : [],
    workingOn: clean(row.working_on) ? [clean(row.working_on)] : [],
    belief: clean(row.belief_creative) || null,
    party: { ...DEFAULT_PARTY },
  };
}

/** Ingest every row through the gate. Returns the person ids written. */
export async function ingestAll(rows: CsvRow[]): Promise<string[]> {
  const written: string[] = [];
  for (const row of rows) {
    const ids = await dispatch("ingest_person", rowToParams(row), {
      src: "csv:test-party",
      actor: "pipeline",
    });
    written.push(...ids);
  }
  return written;
}
