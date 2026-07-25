"use client";

/* Hometown chart: a real world map in equirectangular projection, with a thin
   film-magenta pin dropped on every geocoded hometown.

   The coastlines are coarse polygons in lat/lng rather than a traced SVG path,
   so they go through the SAME projection as the pins — a pin can never drift
   off its continent, whatever the widget is sized to. */

import { useState } from "react";
import { HOMETOWN_PINS } from "./adapter";

const W = 244;
const H = 122;

const px = (lng: number) => ((lng + 180) / 360) * W;
const py = (lat: number) => ((90 - lat) / 180) * H;

/** Coarse continent outlines, [lng, lat]. Recognisable, not survey-grade. */
const LAND: [number, number][][] = [
  // north america
  [[-168, 65], [-152, 71], [-128, 70], [-110, 68], [-95, 72], [-80, 73], [-62, 66], [-55, 52],
   [-66, 45], [-75, 36], [-81, 26], [-90, 29], [-97, 26], [-106, 23], [-114, 30], [-124, 40],
   [-128, 50], [-140, 60], [-160, 62]],
  // south america
  [[-81, 0], [-76, 8], [-60, 11], [-50, 0], [-35, -6], [-38, -14], [-48, -25], [-58, -34],
   [-62, -41], [-68, -52], [-75, -50], [-72, -35], [-71, -18], [-79, -6]],
  // europe
  [[-10, 36], [-9, 43], [-2, 49], [4, 52], [8, 58], [12, 65], [22, 70], [31, 70], [40, 66],
   [40, 55], [36, 45], [28, 41], [20, 40], [12, 44], [3, 42]],
  // africa
  [[-17, 15], [-16, 22], [-6, 35], [10, 37], [24, 32], [35, 30], [43, 12], [51, 11], [42, -2],
   [40, -16], [33, -27], [25, -34], [18, -34], [12, -18], [9, -1], [5, 5], [-8, 5]],
  // asia
  [[40, 55], [55, 62], [70, 72], [90, 76], [110, 77], [135, 72], [160, 68], [180, 66],
   [172, 60], [155, 52], [142, 45], [130, 35], [122, 24], [108, 12], [98, 8], [90, 21],
   [78, 8], [70, 22], [58, 26], [48, 30], [44, 40]],
  // australia
  [[113, -22], [122, -17], [131, -11], [143, -10], [148, -20], [153, -28], [150, -38],
   [140, -38], [129, -32], [117, -34]],
  // greenland
  [[-45, 60], [-30, 68], [-22, 76], [-30, 83], [-50, 82], [-58, 74], [-55, 65]],
];

const toPath = (ring: [number, number][]) =>
  ring.map(([lng, lat], i) => `${i ? "L" : "M"}${px(lng).toFixed(1)} ${py(lat).toFixed(1)}`).join(" ") + " Z";

export default function HometownMap() {
  /* hover label — the native <title> tooltip is a second-long wait; this
     answers instantly. Holds the hovered pin's name, count and position. */
  const [hover, setHover] = useState<{ name: string; n: number; x: number; y: number } | null>(null);
  return (
    <div
      style={{
        position: "absolute",
        right: 20,
        bottom: 128,
        width: W + 28,
        padding: "10px 14px 10px",
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
        hometowns
      </div>
      <svg width={W} height={H} style={{ display: "block" }} role="img" aria-label="guest hometowns">
        {/* land */}
        {LAND.map((ring, i) => (
          <path
            key={i}
            d={toPath(ring)}
            fill="rgba(38,36,44,0.055)"
            stroke="rgba(38,36,44,0.16)"
            strokeWidth={0.6}
            strokeLinejoin="round"
          />
        ))}
        {/* pins — a thin drop, tip exactly on the coordinate */}
        {HOMETOWN_PINS.map((p) => {
          const x = px(p.lng);
          const y = py(p.lat);
          const h = Math.min(11, 6 + Math.sqrt(p.n) * 1.1); // taller with headcount
          const r = h * 0.29;
          const cy = y - h + r;
          return (
            <g
              key={`${p.lat},${p.lng}`}
              onMouseEnter={() => setHover({ name: p.name, n: p.n, x, y })}
              onMouseLeave={() => setHover((cur) => (cur?.name === p.name ? null : cur))}
            >
              {/* generous invisible hit disc — an 8px pin is no hover target */}
              <circle cx={x} cy={cy} r={7} fill="transparent" style={{ pointerEvents: "all" }} />
              {/* the stem: head down to the exact point */}
              <path
                d={`M${x} ${y} L${(x - r * 0.72).toFixed(2)} ${(cy + r * 0.62).toFixed(2)} A${r} ${r} 0 1 1 ${(x + r * 0.72).toFixed(2)} ${(cy + r * 0.62).toFixed(2)} Z`}
                fill="none"
                stroke="rgba(200,149,167,0.95)"
                strokeWidth={0.9}
                strokeLinejoin="round"
              />
              <circle cx={x} cy={cy} r={r * 0.34} fill="rgba(200,149,167,0.95)" />
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          style={{
            position: "absolute",
            /* svg x/y + the card's own padding; clamped inside the card */
            left: Math.max(4, Math.min(hover.x + 14 - 40, W - 60)),
            top: Math.max(2, hover.y + 34 - 26),
            padding: "3px 7px",
            borderRadius: 0,
            background: "rgba(38,36,44,0.86)",
            color: "rgba(255,253,251,0.94)",
            fontFamily: "var(--font-jakarta), sans-serif",
            fontSize: 9.5,
            letterSpacing: "0.04em",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {hover.name.toLowerCase()}
          <span style={{ opacity: 0.55, marginLeft: 5 }}>{hover.n}</span>
        </div>
      )}
    </div>
  );
}
