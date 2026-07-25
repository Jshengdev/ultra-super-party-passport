/**
 * lib/layout.ts — the two layouts the party graph is baked with, ported from the
 * working prototype (scratchpad/graph-lab.html: `simTick` + `ringLayout`).
 *
 * In the prototype both ran in the browser: the web sim ticked inside the raf loop and
 * the rings were recomputed on every resize. Here they run ONCE, at emit time, so the
 * route ships with a position per node per lens and only tweens between them.
 *
 * Determinism is the whole point of moving them: no `Math.random` (a seeded mulberry32
 * supplies the initial scatter), a fixed tick count instead of an alpha-drained loop,
 * and a fixed layout viewport instead of `innerWidth/innerHeight`. Same inputs → same
 * bytes, so a re-emit is a no-op diff and the receipts audit can trust the artifact.
 */

/** the seed the prototype's scatter is replayed with — do NOT change casually: it moves every dot */
export const LAYOUT_SEED = 0x5eed;
/** fixed tick budget (the prototype drained alpha to 0.004 ≈ 366 ticks; 300 is the pinned brief value) */
export const LAYOUT_TICKS = 300;
/** the notional viewport the rings are sized against (the prototype read innerWidth/innerHeight) */
export const LAYOUT_W = 1440;
export const LAYOUT_H = 900;
/**
 * Max px a body may travel in one tick. THE ONE DEPARTURE from the prototype's `simTick`,
 * and it is load-bearing: the prototype's spring impulse grows with distance ((d−46)·d·0.0004),
 * which is stable for its ~40-node demo but diverges at 312 real guests — measured, the
 * positions reach 1e72 by tick 20 and NaN by tick 40. Clamping the per-tick step leaves the
 * settled regime untouched (a converged body moves ≪ 16px/tick) and only bites during the
 * first chaotic ticks. Without it there is no layout at all.
 */
export const MAX_STEP = 16;

export type Vec2 = [number, number];

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  s: string;
  t: string;
  type: string;
}

export type RingKey = "motive" | "asp";

export interface RingNode extends LayoutNode {
  motive?: string | null;
  asp?: string | null;
}

/** mulberry32 — 32-bit seeded PRNG, identical stream on every machine */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * The web lens: the prototype's force sim, run to a fixed tick count.
 *
 * Springs are the structural edges only (school + company) — exactly the edges the web
 * lens draws — so the picture and the physics agree: people cluster because they share
 * a school or a room at work, not because a value tag says so.
 */
export function webLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, Vec2> {
  const rand = mulberry32(LAYOUT_SEED);
  const bodies: Body[] = nodes.map((n) => ({
    id: n.id,
    x: (rand() - 0.5) * 900,
    y: (rand() - 0.5) * 700,
    vx: 0,
    vy: 0,
  }));
  const byId = new Map<string, Body>(bodies.map((b) => [b.id, b]));

  const springs: [Body, Body][] = [];
  for (const e of edges) {
    if (e.type !== "school" && e.type !== "company") continue;
    const a = byId.get(e.s);
    const b = byId.get(e.t);
    if (a && b && a !== b) springs.push([a, b]);
  }

  let alpha = 1;
  for (let tick = 0; tick < LAYOUT_TICKS; tick++) {
    if (alpha < 0.004) break;
    alpha *= 0.985;

    // repulsion (short-range cutoff, exactly as the prototype)
    for (let i = 0; i < bodies.length; i++) {
      const pa = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const pb = bodies[j];
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        if (d2 > 32000) continue;
        const f = (620 * alpha) / d2;
        const dl = Math.sqrt(d2);
        dx /= dl;
        dy /= dl;
        pa.vx += dx * f;
        pa.vy += dy * f;
        pb.vx -= dx * f;
        pb.vy -= dy * f;
      }
    }

    // springs pull shared-world pairs to ~46px
    for (const [a, b] of springs) {
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 46) * 0.02 * alpha;
      dx /= d;
      dy /= d;
      a.vx += dx * f * d * 0.02;
      a.vy += dy * f * d * 0.02;
      b.vx -= dx * f * d * 0.02;
      b.vy -= dy * f * d * 0.02;
    }

    // gravity toward the origin + damping, then the step clamp (see MAX_STEP)
    for (const p of bodies) {
      p.vx -= p.x * 0.0016 * alpha;
      p.vy -= p.y * 0.0016 * alpha;
      p.vx *= 0.86;
      p.vy *= 0.86;
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > MAX_STEP) {
        p.vx = (p.vx / speed) * MAX_STEP;
        p.vy = (p.vy / speed) * MAX_STEP;
      }
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  return new Map(bodies.map((b) => [b.id, [b.x, b.y] as Vec2]));
}

/**
 * The why / seek lenses: one ring per tag, members packed in a phyllotaxis spiral.
 *
 * Groups are ordered biggest-first around the circle and the untagged group ("—") is
 * pushed out past the ring so it reads as the edge of the room rather than a cluster
 * of its own — the route's cluster stamps deliberately skip it (no tag, no label).
 */
export function ringLayout(nodes: readonly RingNode[], key: RingKey): Map<string, Vec2> {
  const groups = new Map<string, RingNode[]>();
  for (const n of nodes) {
    const k = (n[key] ?? "") || "—";
    const arr = groups.get(k);
    if (arr) arr.push(n);
    else groups.set(k, [n]);
  }
  // biggest first; ties broken by tag so the ring is stable across runs
  const keys = [...groups.keys()].sort((a, b) => {
    const d = (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0);
    return d !== 0 ? d : a.localeCompare(b);
  });

  const out = new Map<string, Vec2>();
  const R = Math.min(LAYOUT_W, LAYOUT_H) * 0.56;
  keys.forEach((k, gi) => {
    const ang = (gi / keys.length) * Math.PI * 2 - Math.PI / 2;
    const push = k === "—" ? 1.28 : 1;
    const gx = Math.cos(ang) * R * push;
    const gy = Math.sin(ang) * R * push;
    const members = groups.get(k) ?? [];
    const gr = 14 + Math.sqrt(members.length) * 13;
    members.forEach((p, mi) => {
      const t = mi / Math.max(members.length - 1, 1);
      const a2 = mi * 2.39996; // golden angle
      const r2 = gr * Math.sqrt(t);
      out.set(p.id, [gx + Math.cos(a2) * r2, gy + Math.sin(a2) * r2]);
    });
  });
  return out;
}
