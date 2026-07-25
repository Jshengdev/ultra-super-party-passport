"use client";

/* Thread legend — square corners, sentence case, film hues. Each row toggles
   that connection type across the whole room; a focused person's own threads
   draw regardless. Lifted out of PeplGraph so it is a component the pill row
   can mount and unmount like the ticker and the map. Hiding the box never
   touches `edgeOn` — the threads it last set keep drawing. */

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

export default function ConnectionsLegend({
  edgeOn,
  onToggle,
  bottom,
  ui,
}: {
  edgeOn: Record<RoomEdgeType, boolean>;
  onToggle: (type: RoomEdgeType) => void;
  /** rides above the pill row (and the ticker, when it is up) */
  bottom: number;
  /** the scene's type token — the legend never invents its own */
  ui: CSSProperties;
}) {
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
          marginBottom: 7,
        }}
      >
        connections
      </div>
      {ROWS.map((row) => {
        const on = edgeOn[row.type];
        return (
          <button
            key={row.type}
            className="pepl-item"
            onClick={() => onToggle(row.type)}
            aria-pressed={on}
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
            <span style={{ fontSize: 8.5, color: "rgba(26,25,24,0.32)" }}>
              {COUNT[row.type] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}
