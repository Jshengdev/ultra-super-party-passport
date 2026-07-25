/* 16-segment board core, ported from reference/segment-board-lab.jsx.
   Geometry, glyph masks, field animations, and the film-token palette.
   The board renders straight into the graph sheet canvas (no SVG) so
   the bubble can lens over it. */

import { TAU, hash2, fbm, smoothstep } from "./prng";

/* ---------- cell geometry (reference units: 96 × 148) ---------- */

export const CELL_W = 96;
export const CELL_H = 148;
export const CELL_GAP = 6;

const T = 9;
const PAD = 15;
const GAP = 2.4;
const ht = T / 2;

const L = PAD,
  R = CELL_W - PAD,
  C = CELL_W / 2;
const TOP = PAD,
  BOT = CELL_H - PAD,
  MID = CELL_H / 2;

type Pt = [number, number];

const hexH = (x1: number, x2: number, y: number): Pt[] => [
  [x1, y], [x1 + ht, y - ht], [x2 - ht, y - ht],
  [x2, y], [x2 - ht, y + ht], [x1 + ht, y + ht],
];
const hexV = (y1: number, y2: number, x: number): Pt[] => [
  [x, y1], [x + ht, y1 + ht], [x + ht, y2 - ht],
  [x, y2], [x - ht, y2 - ht], [x - ht, y1 + ht],
];
const diag = (x1: number, y1: number, x2: number, y2: number): Pt[] => {
  const dx = x2 - x1,
    dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const w = T * 0.72;
  const nx = (-dy / len) * (w / 2),
    ny = (dx / len) * (w / 2);
  return [
    [x1 + nx, y1 + ny], [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny], [x1 - nx, y1 - ny],
  ];
};

/* order: a1 a2 b c d1 d2 e f g1 g2 h i j k l m */
export const CELL_SHAPES: Pt[][] = [
  hexH(L + GAP, C - GAP, TOP),
  hexH(C + GAP, R - GAP, TOP),
  hexV(TOP + GAP, MID - GAP, R),
  hexV(MID + GAP, BOT - GAP, R),
  hexH(L + GAP, C - GAP, BOT),
  hexH(C + GAP, R - GAP, BOT),
  hexV(MID + GAP, BOT - GAP, L),
  hexV(TOP + GAP, MID - GAP, L),
  hexH(L + GAP, C - GAP, MID),
  hexH(C + GAP, R - GAP, MID),
  diag(L + T, TOP + T, C - T * 0.8, MID - T * 0.8),
  hexV(TOP + GAP, MID - GAP, C),
  diag(R - T, TOP + T, C + T * 0.8, MID - T * 0.8),
  diag(C - T * 0.8, MID + T * 0.8, L + T, BOT - T),
  hexV(MID + GAP, BOT - GAP, C),
  diag(C + T * 0.8, MID + T * 0.8, R - T, BOT - T),
];

/* per-segment centroids, in cell units (for field sampling + stagger) */
export const SEG_CENTROIDS: Pt[] = CELL_SHAPES.map((shape) => {
  const n = shape.length;
  return [
    shape.reduce((s, p) => s + p[0], 0) / n,
    shape.reduce((s, p) => s + p[1], 0) / n,
  ];
});

/* ---------- glyph masks ---------- */

const IDX: Record<string, number> = {
  a1: 0, a2: 1, b: 2, c: 3, d1: 4, d2: 5, e: 6, f: 7,
  g1: 8, g2: 9, h: 10, i: 11, j: 12, k: 13, l: 14, m: 15,
};
const Mk = (...names: string[]) => {
  let mask = 0;
  for (const n of names) mask |= 1 << IDX[n];
  return mask;
};

/* Full alphabet for the announcement boards. The diagonals h/j/k/m and
   the centre verticals i/l are what make K M N V W X Y Z possible.
   Digits carried from the reference GLYPHS. */
export const ALPHABET: Record<string, number> = {
  A: Mk("a1", "a2", "b", "c", "e", "f", "g1", "g2"),
  B: Mk("a1", "a2", "b", "c", "d1", "d2", "g2", "i", "l"),
  C: Mk("a1", "a2", "d1", "d2", "e", "f"),
  D: Mk("a1", "a2", "b", "c", "d1", "d2", "i", "l"),
  E: Mk("a1", "a2", "d1", "d2", "e", "f", "g1"),
  F: Mk("a1", "a2", "e", "f", "g1"),
  G: Mk("a1", "a2", "c", "d1", "d2", "e", "f", "g2"),
  H: Mk("b", "c", "e", "f", "g1", "g2"),
  I: Mk("a1", "a2", "d1", "d2", "i", "l"),
  J: Mk("b", "c", "d1", "d2", "e"),
  K: Mk("e", "f", "g1", "j", "m"),
  L: Mk("d1", "d2", "e", "f"),
  M: Mk("b", "c", "e", "f", "h", "j"),
  N: Mk("b", "c", "e", "f", "h", "m"),
  O: Mk("a1", "a2", "b", "c", "d1", "d2", "e", "f"),
  P: Mk("a1", "a2", "b", "e", "f", "g1", "g2"),
  Q: Mk("a1", "a2", "b", "c", "d1", "d2", "e", "f", "m"),
  R: Mk("a1", "a2", "b", "e", "f", "g1", "g2", "m"),
  S: Mk("a1", "a2", "c", "d1", "d2", "f", "g1", "g2"),
  T: Mk("a1", "a2", "i", "l"),
  U: Mk("b", "c", "d1", "d2", "e", "f"),
  V: Mk("e", "f", "j", "k"),
  W: Mk("b", "c", "e", "f", "k", "m"),
  X: Mk("h", "j", "k", "m"),
  Y: Mk("h", "j", "l"),
  Z: Mk("a1", "a2", "d1", "d2", "j", "k"),
  "0": Mk("a1", "a2", "b", "c", "d1", "d2", "e", "f"),
  "1": Mk("b", "c"),
  "2": Mk("a1", "a2", "b", "g1", "g2", "e", "d1", "d2"),
  "3": Mk("a1", "a2", "b", "c", "d1", "d2", "g2"),
  "4": Mk("b", "c", "f", "g1", "g2"),
  "5": Mk("a1", "a2", "c", "d1", "d2", "f", "g1", "g2"),
  "6": Mk("a1", "a2", "c", "d1", "d2", "e", "f", "g1", "g2"),
  "7": Mk("a1", "a2", "b", "c"),
  "8": Mk("a1", "a2", "b", "c", "d1", "d2", "e", "f", "g1", "g2"),
  "9": Mk("a1", "a2", "b", "c", "d1", "d2", "f", "g1", "g2"),
  " ": 0,
  "-": Mk("g1", "g2"),
  /* no dot segment exists on a 16-seg cell; a low left tick reads as one */
  ".": Mk("d1"),
};

export const maskFor = (ch: string): number => ALPHABET[ch.toUpperCase()] ?? 0;

/* ---------- fields ----------
   signature: (x, y, t, cell, seg, aspect) -> brightness 0..1
   x/y are 0..1 across the board; aspect keeps spatial frequency square
   on boards of any column count. */

export type FieldFn = (
  x: number,
  y: number,
  t: number,
  cell: number,
  seg: number,
  aspect: number
) => number;

export const FIELDS: Record<string, FieldFn> = {
  /* advection cartography — domain-warped noise contours */
  cartography: (x, y, t, _c, _s, aspect) => {
    const X = x * 2.2 * (aspect * 0.5);
    const Y = y * 2.2;
    const qx = fbm(X + t * 0.1, Y);
    const qy = fbm(X + 5.2, Y + t * 0.09);
    const n = fbm(X + 1.9 * qx + t * 0.04, Y + 1.9 * qy);
    const f = Math.sin(n * TAU * 2.6 - t * 0.25);
    return smoothstep(0.05, 0.65, f);
  },

  /* signal weather — fbm cloud cover with slow amplitude gusts */
  weather: (x, y, t, _c, _s, aspect) => {
    const X = x * 3.4 * (aspect * 0.5);
    const Y = y * 2.8;
    const clouds = fbm(X + t * 0.14, Y - t * 0.06);
    const gust = 0.55 + 0.45 * Math.sin(t * 0.23 + fbm(X * 0.4, Y * 0.4) * 5);
    return smoothstep(
      0.42,
      0.66,
      clouds * gust + 0.12 * Math.sin(t * 0.5 + x * 6)
    );
  },

  /* deep star mechanics — sparse twinkles inside drifting nebulae */
  stars: (x, y, t, cell, seg, aspect) => {
    const h1 = hash2(cell * 3.1, seg * 1.3);
    const h2 = hash2(seg * 7.7, cell * 0.9);
    const tw = Math.pow(
      Math.max(0, Math.sin(t * (0.25 + h1 * 0.6) * TAU * 0.35 + h2 * TAU)),
      8
    );
    const nebula = smoothstep(
      0.48,
      0.72,
      fbm(x * 2.6 * (aspect * 0.5) + t * 0.03, y * 2.2 - t * 0.02)
    );
    return tw * (0.12 + 0.88 * nebula);
  },
};

export type FieldName = keyof typeof FIELDS;
export const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];

/* ---------- film token palette ----------
   locked to the design tokens: five film colors keyed by thin-film
   thickness. every rendered color is a token or a blend of two
   adjacent tokens — never an arbitrary spectrum color. */

const FILM: Record<string, [number, number, number]> = {
  gold: [0xfe, 0xe0, 0xae],    // 140nm — warm accent
  magenta: [0xc8, 0x95, 0xa7], // 190nm — primary
  blue: [0x91, 0xb4, 0xf9],    // 240nm — secondary
  violet: [0xc1, 0x99, 0xf9],  // 420nm — sparingly
  mint: [0x91, 0xeb, 0xb7],    // 480nm — sparingly
};

const STOPS: { u: number; c: [number, number, number] }[] = [
  { u: 0.0, c: FILM.gold },
  { u: 0.35, c: FILM.magenta },
  { u: 0.65, c: FILM.blue },
  { u: 0.85, c: FILM.violet },
  { u: 0.95, c: FILM.mint },
  { u: 1.0, c: FILM.gold }, // wrap — continuous cycle, no seams
];

export type FilmSample = { r: number; g: number; b: number; sheen: number };

export const filmColor = (
  x: number,
  y: number,
  t: number,
  aspect: number
): FilmSample => {
  const X = x * aspect * 0.62;

  const sheen = Math.pow(
    Math.max(0, Math.sin((x * 1.35 - y * 0.5) * TAU * 0.75 - t * 0.38)),
    10
  );

  const drift = fbm(X * 1.7 + t * 0.05, y * 1.9 - t * 0.035);

  const raw = 0.12 + 0.6 * drift + 0.24 * y + t * 0.02 + sheen * 0.1;
  const u = raw - Math.floor(raw);

  let a = STOPS[0],
    b = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (u >= STOPS[i].u && u <= STOPS[i + 1].u) {
      a = STOPS[i];
      b = STOPS[i + 1];
      break;
    }
  }
  const f = (u - a.u) / (b.u - a.u);
  const ff = f * f * (3 - 2 * f);
  return {
    r: (a.c[0] + (b.c[0] - a.c[0]) * ff) | 0,
    g: (a.c[1] + (b.c[1] - a.c[1]) * ff) | 0,
    b: (a.c[2] + (b.c[2] - a.c[2]) * ff) | 0,
    sheen,
  };
};
