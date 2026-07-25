"use client";

/* Thread legend — square corners, sentence case, film hues. Each row toggles
   that connection type across the whole room; a focused person's own threads
   draw regardless. Lifted out of PeplGraph so it is a component the pill row
   can mount and unmount like the ticker and the map. Hiding the box never
   touches `edgeOn` — the threads it last set keep drawing.

   TWO SOURCES, ONE SWITCH. `focusKey` is the only mode signal: null and the
   ROOM speaks (every tie in the bake, counted by type); set and THIS PERSON
   speaks — same box, their numbers.
   · The NUMBERS are always ROOM_EDGES, in person mode simply filtered to
     them: the same baked artifact, and the COMPLETE tie set. Never count
     `focusEdges` — a person record carries the emitter's RANKED, CAPPED
     shortlist (8 toward-you + 12 other, scripts/emit-graph.ts), so counting
     it would silently under-report a busy person.
   · The VALUE layer — who their strongest ties are — exists ONLY on that
     record, so it renders only once the scene's fetch lands. Until then it
     is absent, never a placeholder and never a zero.
   Both sources are baked by scripts/emit-graph.ts, and a human corrects them
   at ONE station: data/graph-overrides.csv (pinned_match reorders a person's
   ties, hide removes someone) plus a re-run of the emit — never by editing
   public/graph/* by hand.
   The rows stay toggles in BOTH modes: the switch floods the room with a
   thread type, which is a property of the room, not of the selection. */

import type { CSSProperties } from "react";
import { ROOM_EDGES, type RoomEdgeType } from "./adapter";

const ROWS: { type: RoomEdgeType; label: string; hue: string }[] = [
  { type: "why", label: "Shared conviction", hue: "var(--film-violet)" },
  { type: "seek", label: "Seeking match", hue: "var(--film-magenta)" },
  { type: "school", label: "Same school", hue: "var(--film-blue)" },
  { type: "company", label: "Same company", hue: "var(--film-gold)" },
];

/* How many threads of each type the room holds — fixed for the session, since
   PartyScene seeds ROOM_EDGES before it imports the scene. One pass here, not
   four filters over every edge on every render. */
const COUNT: Partial<Record<RoomEdgeType, number>> = {};
for (const e of ROOM_EDGES) COUNT[e.type] = (COUNT[e.type] ?? 0) + 1;

/** one edge of the focused person's baked record — the narrow read of
    PersonRecord["edges"] (declared where it is fetched, in PeplGraph). */
type FocusEdge = {
  targetId: string;
  type: string;
  direction?: "mutual" | "inbound" | "outbound";
  via: string;
};

/** how many rows of the value layer fit before the box stops being a peek */
const STRONGEST = 3;

export default function ConnectionsLegend({
  edgeOn,
  onToggle,
  bottom,
  ui,
  focusKey,
  focusEdges,
  nameOf,
}: {
  edgeOn: Record<RoomEdgeType, boolean>;
  onToggle: (type: RoomEdgeType) => void;
  /** rides above the pill row (and the ticker, when it is up) */
  bottom: number;
  /** the scene's type token — the legend never invents its own */
  ui: CSSProperties;
  /** the selected person, or null for the room. THE mode signal. */
  focusKey: string | null;
  /** their record's edges, already ranked by the emitter — empty while the
      scene's fetch is in flight, which reads as absence, not as zero */
  focusEdges: FocusEdge[];
  /** the scene's own id → display name resolver */
  nameOf: (id: string) => string;
}) {
  /* their per-type counts, from the complete tie set. Mutual seeks are baked
     as two directed edges — key by partner+type so one tie counts once,
     exactly as their record lists it once. */
  const countTies = (id: string): Record<RoomEdgeType, number> => {
    const n: Record<RoomEdgeType, number> = { why: 0, seek: 0, school: 0, company: 0 };
    const seen = new Set<string>();
    for (const e of ROOM_EDGES) {
      const other = e.s === id ? e.t : e.t === id ? e.s : "";
      if (!other || seen.has(`${e.type}:${other}`)) continue;
      seen.add(`${e.type}:${other}`);
      n[e.type] += 1;
    }
    return n;
  };
  const ties = focusKey ? countTies(focusKey) : null;
  const total = ties ? ties.why + ties.seek + ties.school + ties.company : 0;
  /* the record ARRIVES ranked (mutual → inbound → outbound → why → company →
     school, then strength, with a pinned_match pulled to the front) — take
     the head, never re-rank, or a human's pin stops governing. */
  const strongest = focusKey ? focusEdges.slice(0, STRONGEST) : [];
  /* the section hairline the threads widget speaks in */
  const header: CSSProperties = {
    ...ui,
    textTransform: "none",
    fontSize: 9,
    letterSpacing: "0.05em",
    color: "rgba(26,25,24,0.36)",
    paddingBottom: 3,
    borderBottom: "1px solid rgba(38,36,44,0.05)",
    marginBottom: 3,
  };
  return (
    <div
      style={{
        position: "absolute",
        left: 20,
        bottom,
        width: 184,
        padding: "10px 14px 12px",
        borderRadius: 0,
        background: "rgba(255,253,251,0.78)",
        backdropFilter: "blur(12px)",
        boxShadow:
          "inset 0 0 0 1px rgba(255,255,255,0.55), 0 0 0 1px rgba(38,36,44,0.045)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-hedvig), Georgia, serif",
          fontSize: 15,
          letterSpacing: "0.01em",
          color: "rgba(38,36,44,0.6)",
          marginBottom: focusKey ? 4 : 7,
        }}
      >
        connections
      </div>
      {/* re-keyed on the mode signal so the whole readout rises on the flip
          and again on the way back — the room's own entrance grammar, and
          the reduced-motion rule that stills it is already written */}
      <div className="pepl-group" key={focusKey ?? "room"}>
        {focusKey && (
          <div style={{ ...header, display: "flex", gap: 6, alignItems: "baseline" }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                /* the name as they wrote it — capitalize only lifts the
                   all-lowercase ids, it never flattens a MacIlvaine */
                textTransform: "capitalize",
                color: "rgba(26,25,24,0.6)",
                fontSize: 10.5,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {nameOf(focusKey)}
            </span>
            <span style={{ fontSize: 8.5, color: "rgba(26,25,24,0.32)" }}>
              {total === 1 ? "1 tie" : `${total} ties`}
            </span>
          </div>
        )}
        {ROWS.map((row) => {
          const on = edgeOn[row.type];
          const n = ties ? ties[row.type] : COUNT[row.type] ?? 0;
          return (
            <button
              key={row.type}
              className="pepl-item"
              onClick={() => onToggle(row.type)}
              aria-pressed={on}
              aria-label={`${row.label} — ${n} ${focusKey ? "of theirs" : "in the room"}, toggle these threads across the room`}
              style={{
                ...ui,
                textTransform: "none",
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "4px 4px",
                border: "none",
                borderRadius: 0,
                background: "transparent",
                color: on ? "rgba(26,25,24,0.72)" : "rgba(26,25,24,0.34)",
                fontSize: 10.5,
                letterSpacing: "0.02em",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 2,
                  background: row.hue,
                  opacity: on ? 0.95 : 0.3,
                  flex: "none",
                }}
              />
              <span style={{ flex: 1, whiteSpace: "nowrap" }}>{row.label}</span>
              <span style={{ fontSize: 8.5, color: "rgba(26,25,24,0.32)" }}>{n}</span>
            </button>
          );
        })}
        {/* the value layer — record-only, so it arrives a beat later and
            rises on its own; nothing stands in for it while it is missing */}
        {strongest.length > 0 && (
          <div className="pepl-group" style={{ marginTop: 8 }}>
            <div style={header}>Strongest ties</div>
            {strongest.map((e) => (
              <div
                key={`${e.type}:${e.targetId}`}
                style={{
                  ...ui,
                  textTransform: "none",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 6,
                  padding: "2px 4px",
                  fontSize: 10.5,
                  letterSpacing: "0.015em",
                  color: "rgba(26,25,24,0.62)",
                }}
              >
                <span
                  style={{
                    /* the name holds its ground up to 70% of the row; it is
                       the via that gives way first */
                    flexShrink: 0,
                    maxWidth: "70%",
                    textTransform: "capitalize",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {nameOf(e.targetId)}
                </span>
                <span
                  style={{
                    minWidth: 0,
                    fontSize: 8.5,
                    color: "rgba(26,25,24,0.34)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {e.direction === "mutual" ? `both ways · ${e.via}` : e.via}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
