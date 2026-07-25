/* Step-0 CSV verification — pure, Node-importable (no DOM), shared by GraphLab and the entry gate. */

export type CsvVerdict =
  | { ok: true; rows: number; ids: number; matched: number; ratio: number }
  | { ok: false; code: string; message: string };

export function pickIdField(fields: string[]): string | null {
  const norm = (f: string) => f.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (
    fields.find((f) => /^guest_?id$/.test(norm(f))) ??
    fields.find((f) => /^(api_?id|luma_?id|ticket_?id|person_?id)$/.test(norm(f))) ??
    fields.find((f) => /(^|_)id$/.test(norm(f))) ??
    null
  );
}

/**
 * The question is "is our party inside this file?", not "is this file only our party".
 * The dragged export legitimately carries MORE than the baked room (pending/invited
 * rows, duplicate ticket rows) — so the ratio is coverage of the BAKED list:
 * |unique dragged ids ∩ guestIds| / |guestIds|. A foreign guest list still fails (~0%).
 */
export function verifyGuestList(rows: Record<string, unknown>[], fields: string[], guestIds: string[]): CsvVerdict {
  if (rows.length === 0) {
    return { ok: false, code: "EMPTY_CSV", message: "no data rows — that file has a header and nothing under it." };
  }
  if (guestIds.length === 0) {
    return {
      ok: false,
      code: "GUEST_IDS_UNAVAILABLE",
      message: "graph.json carries no meta.guestIds, so this file cannot be verified against the party list.",
    };
  }
  const idField = pickIdField(fields);
  if (!idField) {
    return {
      ok: false,
      code: "GUEST_ID_COLUMN_MISSING",
      message: "no guest_id column in that CSV. The party export has one — this file is something else.",
    };
  }
  const known = new Set(guestIds.map((g) => String(g).trim()));
  const dragged = new Set<string>();
  for (const r of rows) {
    const raw = r[idField];
    const v = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    if (v) dragged.add(v);
  }
  if (dragged.size === 0) {
    return { ok: false, code: "GUEST_ID_COLUMN_EMPTY", message: `every "${idField}" cell in that file is blank.` };
  }
  let covered = 0;
  for (const id of known) if (dragged.has(id)) covered += 1;
  const ratio = covered / known.size;
  if (ratio < 0.9) {
    return {
      ok: false,
      code: "GUEST_LIST_MISMATCH",
      message: `this file covers ${covered} of the ${known.size} people in this party's room (${Math.round(ratio * 100)}% — needs 90%). This is a real guest list, but it isn't ours.`,
    };
  }
  return { ok: true, rows: rows.length, ids: dragged.size, matched: covered, ratio };
}
