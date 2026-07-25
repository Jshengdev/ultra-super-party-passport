/* Deterministic cluster layout. Seeded, so reloads look identical.
   Everything is computed in sheet pixels for a given viewport — the
   sheet is an offscreen canvas the lens and the Monet pass consume,
   so nothing here may assume it draws to screen. */

import type { Group, Person } from "./adapter";
import { mulberry32, TAU } from "./prng";
import { CELL_W, CELL_H, CELL_GAP } from "./segments";

export type BoardSlot = {
  x: number; // top-left, sheet px
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
  scale: number; // sheet px per cell unit
};

export type ClusterLayout = {
  group: Group;
  index: number;
  cx: number;
  cy: number;
  radius: number;
  board: BoardSlot;
};

export type DotLayout = {
  person: Person;
  clusterIndex: number;
  x: number;
  y: number;
  baseR: number;
  phase: number; // per-dot drift phase
  speed: number;
  /* label placement, chosen so rest labels don't pile up */
  labelSide: 1 | -1;
  labelDy: number;
  labelVis: boolean; // false → shown only on hover/focus
  /* generative glyph: one rect-class base + one round accent + one
     unique accent — everyone's dot is family-alike, no two identical */
  shape: { rect: number; round: number; uniq: number; rot: number };
};

export type GraphLayout = {
  clusters: ClusterLayout[];
  dots: DotLayout[];
  w: number;
  h: number;
};

const SEED = 20260725;

export function computeLayout(
  groups: Group[],
  people: Person[],
  w: number,
  h: number
): GraphLayout {
  const rng = mulberry32(SEED);
  const mn = Math.min(w, h);

  const byGroup = new Map<string, Person[]>();
  for (const g of groups) byGroup.set(g.id, []);
  for (const p of people) byGroup.get(p.groupId)?.push(p);

  /* board cell size — the board must fit the longest name it will
     ever spell (group name or any member), one row */
  const cellH = Math.max(15, Math.min(24, mn * 0.028));
  const scale = cellH / CELL_H;
  const cellW = CELL_W * scale;
  const gap = CELL_GAP * scale;

  /* cluster radii from member share — share-based so real datasets
     (hundreds of people, lopsided groups) still compose on screen */
  const total = Math.max(1, people.length);
  const radii = groups.map((g) => {
    const n = byGroup.get(g.id)!.length;
    return mn * (0.045 + 0.24 * Math.sqrt(n / total));
  });
  /* dots shrink gently as the dataset grows */
  const dotScale = Math.min(1, Math.max(0.6, Math.sqrt(80 / total)));

  /* initial ring placement, then a deterministic relaxation that
     pushes clusters apart and inside the frame */
  const cx0 = w / 2,
    cy0 = h / 2;
  const pos = groups.map((_, i) => {
    const a = (i / groups.length) * TAU + rng() * 0.5 - 1.2;
    const rr = mn * (0.31 + rng() * 0.06);
    return {
      x: cx0 + Math.cos(a) * rr * (w / mn) * 0.82,
      y: cy0 + Math.sin(a) * rr * 0.86,
    };
  });

  const boardH = cellH * 1.6; // room reserved under each cluster
  for (let iter = 0; iter < 120; iter++) {
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const d = Math.hypot(dx, dy) || 1;
        const min =
          radii[i] + radii[j] + boardH + mn * (groups.length > 4 ? 0.055 : 0.15);
        if (d < min) {
          const push = ((min - d) / d) * 0.5;
          pos[i].x -= dx * push * 0.5;
          pos[i].y -= dy * push * 0.5;
          pos[j].x += dx * push * 0.5;
          pos[j].y += dy * push * 0.5;
        }
      }
      /* keep the cluster + its board inside the frame */
      const mX = radii[i] + mn * 0.05;
      const mTop = radii[i] + mn * 0.04;
      const mBot = radii[i] + boardH + mn * 0.06;
      pos[i].x = Math.min(Math.max(pos[i].x, mX), w - mX);
      pos[i].y = Math.min(Math.max(pos[i].y, mTop), h - mBot);
      /* gentle pull to centre keeps the composition from pinning to walls */
      pos[i].x += (cx0 - pos[i].x) * 0.002;
      pos[i].y += (cy0 - pos[i].y) * 0.002;
    }
  }

  const clusters: ClusterLayout[] = groups.map((g, i) => {
    const members = byGroup.get(g.id)!;
    const longest = Math.max(
      g.name.length,
      ...members.map((p) => p.name.length)
    );
    const cols = Math.min(18, longest);
    const bw = cols * (cellW + gap) + gap;
    const bh = cellH + gap * 2;
    const bx = Math.min(Math.max(pos[i].x - bw / 2, mn * 0.02), w - bw - mn * 0.02);
    const by = pos[i].y + radii[i] + mn * 0.042;
    return {
      group: g,
      index: i,
      cx: pos[i].x,
      cy: pos[i].y,
      radius: radii[i],
      board: { x: bx, y: by, w: bw, h: bh, cols, rows: 1, scale },
    };
  });

  /* dots: jittered phyllotaxis inside each cluster — even, organic */
  const dots: DotLayout[] = [];
  const GOLDEN = 2.399963229728653;
  clusters.forEach((cl, ci) => {
    const members = byGroup.get(cl.group.id)!;
    const n = members.length;
    members.forEach((p, k) => {
      const rr = cl.radius * (0.16 + 0.8 * Math.sqrt((k + 0.5) / n));
      const th = k * GOLDEN + rng() * 0.55;
      /* shape combo hashed from the person's id — stable across
         layouts and datasets */
      let hsh = 0;
      for (let q = 0; q < p.id.length; q++) hsh = (hsh * 31 + p.id.charCodeAt(q)) >>> 0;
      dots.push({
        person: p,
        clusterIndex: ci,
        x: cl.cx + Math.cos(th) * rr * (1 + (rng() - 0.5) * 0.16),
        y: cl.cy + Math.sin(th) * rr * (1 + (rng() - 0.5) * 0.16),
        baseR: (2.1 + rng() * 1.6) * dotScale,
        phase: rng() * TAU,
        speed: 0.4 + rng() * 0.5,
        labelSide: 1,
        labelDy: 0,
        labelVis: true,
        shape: {
          rect: hsh % 4,
          round: (hsh >>> 2) % 3,
          uniq: (hsh >>> 4) % 4,
          rot: (((hsh >>> 6) % 100) / 100 - 0.5) * 0.9,
        },
      });
    });
  });

  /* every dot carries a name at rest — place labels greedily so they
     don't pile up: try right/left and three vertical nudges; a dot
     whose label can't fit anywhere keeps it for hover/focus only.
     Bigger dots claim space first. Deterministic, so no flicker. */
  const FS = 8.5; // label font size used by the sheet
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  /* reserve every serif group-name area first (mirrors the baked-name
     geometry in sheet.ts: width b.w+48, height max(b.h*2.4, 44)) —
     labels must never paint across a group's inscription */
  for (const cl of clusters) {
    const b = cl.board;
    const nw = b.w + 48;
    const nh = Math.max(b.h * 2.4, 44);
    placed.push({ x: b.x + b.w / 2 - nw / 2, y: b.y + b.h / 2 - nh / 2, w: nw, h: nh });
  }
  const order = dots
    .map((_, i) => i)
    .sort((a, b) => dots[b].baseR - dots[a].baseR || a - b);
  for (const i of order) {
    const d = dots[i];
    const lw = d.person.name.length * FS * 0.62 + 6;
    const lh = 9;
    let ok = false;
    /* remember the least-bad spot so a culled label revealed on hover
       appears where it collides least, not where it collided first */
    let bestOverlap = Infinity;
    let bestSide: 1 | -1 = 1;
    let bestDy = 0;
    outer: for (const side of [1, -1] as const) {
      for (const dy of [0, -7, 7]) {
        const lx = side === 1 ? d.x + d.baseR + 5 : d.x - d.baseR - 5 - lw;
        const ly = d.y + dy - lh / 2;
        let overlap = 0;
        for (const r of placed) {
          const ox = Math.min(lx + lw, r.x + r.w) - Math.max(lx, r.x);
          const oy = Math.min(ly + lh, r.y + r.h) - Math.max(ly, r.y);
          if (ox > 0 && oy > 0) overlap += ox * oy;
        }
        if (overlap === 0) {
          d.labelSide = side;
          d.labelDy = dy;
          d.labelVis = true;
          placed.push({ x: lx, y: ly, w: lw, h: lh });
          ok = true;
          break outer;
        }
        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          bestSide = side;
          bestDy = dy;
        }
      }
    }
    if (!ok) {
      d.labelSide = bestSide;
      d.labelDy = bestDy;
      d.labelVis = false;
    }
  }

  return { clusters, dots, w, h };
}
