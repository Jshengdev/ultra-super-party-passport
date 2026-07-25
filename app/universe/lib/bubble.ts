/**
 * app/universe/lib/bubble.ts — the glass-bubble orb.
 *
 * Every person in the Universe is a soap bubble on a bright canvas. The look is
 * taken from real thin-film interference, which is why it reads as glass rather
 * than as a coloured disc:
 *
 *   - the CENTRE is nearly transparent — you see the canvas through it
 *   - the RIM is where the colour lives, because at a grazing angle the film is
 *     optically thicker and the interference fringes bunch up there
 *   - a small SPECULAR highlight sits up-left, with a fainter bounce down-right
 *   - the whole thing sits on a soft, tinted contact glow instead of a hard edge
 *
 * There are no dark strokes anywhere. A bubble has no outline; it has a bright
 * edge. That is the entire difference between "circle" and "glass".
 *
 * PERFORMANCE. The force graph repaints every node every frame, and the party
 * graph is 193 people today and 364 on the new guest list. Building four
 * gradients per node per frame would melt the simulation, so each (hue, size)
 * pair is rasterised ONCE into an offscreen sprite and blitted with drawImage.
 * The cache is bounded — see SPRITE_BUDGET.
 */

/** Sprites are drawn at this pixel size, then scaled to the node's radius. */
const SPRITE_PX = 128;

/** Bounded so a long session with many hues cannot grow without limit. */
const SPRITE_BUDGET = 96;

const spriteCache = new Map<string, HTMLCanvasElement>();

/** Parse any CSS colour the tokens might hold into [r,g,b]. */
function toRgb(color: string): [number, number, number] {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map((p) => parseFloat(p));
    return [r || 0, g || 0, b || 0];
  }
  return [200, 200, 220];
}

function rgba([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}

/** Rotate a colour through the spectrum — the fringe shift across the film. */
function shift([r, g, b]: [number, number, number], deg: number): [number, number, number] {
  // cheap hue rotation in RGB space; exact enough for a 3px iridescent rim and
  // far cheaper than a round-trip through HSL for every stop of every sprite.
  const cos = Math.cos((deg * Math.PI) / 180);
  const sin = Math.sin((deg * Math.PI) / 180);
  const m = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return [
    clamp(r * m[0] + g * m[1] + b * m[2]),
    clamp(r * m[3] + g * m[4] + b * m[5]),
    clamp(r * m[6] + g * m[7] + b * m[8]),
  ];
}

/**
 * Rasterise one bubble. `hue` anchors the sprite to the person's value cloud, so
 * cluster identity still reads at a glance — the iridescence fans out around
 * that hue rather than replacing it with an arbitrary rainbow.
 */
function renderSprite(hue: string, intensity: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = SPRITE_PX;
  cv.height = SPRITE_PX;
  const ctx = cv.getContext('2d');
  const base = toRgb(hue);
  if (!ctx) return cv;

  const c = SPRITE_PX / 2;
  // leave headroom inside the sprite for the outer glow
  const r = SPRITE_PX * 0.42;

  // ---- 1. contact glow: a soft tinted bloom, never a shadow -----------------
  const glow = ctx.createRadialGradient(c, c, r * 0.82, c, c, r * 1.18);
  glow.addColorStop(0, rgba(base, 0.22 * intensity));
  glow.addColorStop(1, rgba(base, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(c, c, r * 1.18, 0, Math.PI * 2);
  ctx.fill();

  // ---- 2. body: translucent at the core, gathering colour toward the rim ----
  // offset up-left so the sphere has a light direction
  // NOTE ON TUNING: a node is only ~12-18px on screen at default zoom, so the
  // sprite is downscaled ~8x. Anything subtle here averages away to grey. The
  // hue therefore has to be carried further into the body than a photographic
  // bubble would, or the orb reads as a pale disc once it is small.
  const body = ctx.createRadialGradient(c - r * 0.28, c - r * 0.32, r * 0.05, c, c, r);
  body.addColorStop(0.0, rgba([255, 255, 255], 0.58 * intensity));
  body.addColorStop(0.3, rgba(base, 0.3 * intensity));
  body.addColorStop(0.68, rgba(base, 0.5 * intensity));
  body.addColorStop(0.9, rgba(base, 0.76 * intensity));
  body.addColorStop(1.0, rgba(shift(base, 28), 0.66 * intensity));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();

  // ---- 3. the iridescent rim — the part that says "bubble" ------------------
  // A conic sweep clipped to a thin annulus: the fringes travel around the edge
  // exactly the way they do in the reference photographs.
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  // a generous annulus — thin enough to read as a rim, wide enough to survive
  // the ~8x downscale to node size
  ctx.arc(c, c, r * 0.7, 0, Math.PI * 2, true); // annulus via even-odd
  ctx.clip('evenodd');

  if (typeof ctx.createConicGradient === 'function') {
    const rim = ctx.createConicGradient(-0.9, c, c);
    // sweep the film through the spectrum and back to the anchor hue
    const stops: [number, number][] = [
      [0.0, 0], [0.16, 55], [0.33, 130], [0.5, 195], [0.66, 255], [0.83, 310], [1.0, 360],
    ];
    for (const [at, deg] of stops) {
      rim.addColorStop(at, rgba(shift(base, deg), 0.9 * intensity));
    }
    ctx.fillStyle = rim;
  } else {
    // Safari < 16.4 and friends: a plain bright rim still reads as glass.
    ctx.fillStyle = rgba(shift(base, 40), 0.85 * intensity);
  }
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ---- 4. bright edge highlight, brightest where the light hits -------------
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = SPRITE_PX * 0.012;
  ctx.strokeStyle = rgba([255, 255, 255], 0.55 * intensity);
  ctx.beginPath();
  ctx.arc(c, c, r * 0.965, Math.PI * 0.95, Math.PI * 1.75);
  ctx.stroke();
  ctx.restore();

  // ---- 5. specular: the little window reflection ---------------------------
  ctx.save();
  ctx.translate(c - r * 0.36, c - r * 0.42);
  ctx.rotate(-0.5);
  ctx.scale(1, 0.62);
  const spec = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.3);
  spec.addColorStop(0, rgba([255, 255, 255], 0.92 * intensity));
  spec.addColorStop(1, rgba([255, 255, 255], 0));
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ---- 6. bounce light on the far side, so it reads as a sphere ------------
  const bounce = ctx.createRadialGradient(c + r * 0.34, c + r * 0.44, 0, c + r * 0.34, c + r * 0.44, r * 0.4);
  bounce.addColorStop(0, rgba([255, 255, 255], 0.3 * intensity));
  bounce.addColorStop(1, rgba([255, 255, 255], 0));
  ctx.fillStyle = bounce;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();

  return cv;
}

/** Cached sprite for a hue. `intensity` is quantised so the cache stays small. */
export function bubbleSprite(hue: string, intensity = 1): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const q = Math.round(Math.max(0.15, Math.min(1, intensity)) * 10) / 10;
  const key = `${hue}|${q}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;
  const made = renderSprite(hue, q);
  if (spriteCache.size >= SPRITE_BUDGET) {
    const oldest = spriteCache.keys().next().value;
    if (oldest !== undefined) spriteCache.delete(oldest);
  }
  spriteCache.set(key, made);
  return made;
}

/**
 * Blit a bubble centred on (x, y) with the given graph-space radius.
 * `r` is the visual radius; the sprite carries its own glow padding beyond it.
 */
export function drawBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  hue: string,
  intensity = 1,
): void {
  const sprite = bubbleSprite(hue, intensity);
  if (!sprite) return;
  // the drawn box is wider than r because the sprite reserves 42% for glow
  const box = r / 0.42;
  ctx.drawImage(sprite, x - box, y - box, box * 2, box * 2);
}

/** Drop cached sprites — call when the design tokens change under us. */
export function resetBubbleCache(): void {
  spriteCache.clear();
}
