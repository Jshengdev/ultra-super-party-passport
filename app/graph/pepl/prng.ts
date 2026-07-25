/* Deterministic randomness + the noise toolkit shared by the layout,
   the segment fields, and the film palette. Ported from
   reference/segment-board-lab.jsx so the motion character matches. */

export const TAU = Math.PI * 2;

/* seeded PRNG — layout must look identical on every reload */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const smoothstep = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* deterministic hash -> 0..1 */
export const hash2 = (x: number, y: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/* smooth value noise */
export const vnoise = (x: number, y: number) => {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const xf = x - xi,
    yf = y - yi;
  const u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi),
    b = hash2(xi + 1, yi),
    c = hash2(xi, yi + 1),
    d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

/* 3-octave fractal noise */
export const fbm = (x: number, y: number) =>
  vnoise(x, y) * 0.55 +
  vnoise(x * 2.1 + 13.7, y * 2.1 + 7.3) * 0.3 +
  vnoise(x * 4.3 + 29.1, y * 4.3 + 17.9) * 0.15;
