/* GraphSheet — renders the entire graph (dots, boards, labels) to an
   offscreen canvas. The bubble shader and the Monet pass consume this
   as a texture; nothing here assumes it draws to screen. */

import { computeLayout, GraphLayout } from "./sheetLayout";
import { CELL_SHAPES, CELL_W, CELL_GAP } from "./segments";
import type { BoardState } from "./boards";
import type { GraphAdapter, RoomEdge, RoomEdgeType } from "./adapter";

const CREAM = "#f7f6f4";
const INK = "26,25,24";
const SEG_OFF = `rgba(${INK},0.02)`; // --seg-off, exactly as tokened
const GLOW_SCALE = 0.34;
const GLOW_PAD = 26; // board-space px of bleed around the glow blit

export type SheetFrame = {
  t: number;
  dt: number;
  reduced: boolean;
  /* scene camera: world point (x,y) shown at view centre, scale s.
     This is the "actual zoom" — the sheet re-renders crisp at scale. */
  cam: { s: number; x: number; y: number };
  hoveredId: string | null;
  focusedId: string | null;
  boards: (BoardState | null)[]; // per cluster; null → ghost slot
  boardsDirty: boolean[]; // true when a board's arrays were recomputed
  nameAlpha: number[]; // per cluster — serif group-name fade, 1 at rest
  labelFor: (dotIndex: number) => number; // microlabel alpha, 0..1
  dotEmphasis: (dotIndex: number) => number; // scale target, 1 = rest
  /** legend toggles: draw this thread type across the WHOLE room at rest.
      A focused/hovered person's own threads always draw, toggled or not. */
  edgeOn: Record<RoomEdgeType, boolean>;
};

export class GraphSheet {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  layout: GraphLayout | null = null;
  fontFamily = "system-ui, sans-serif";
  serifFamily = "Georgia, serif";
  private dpr = 1;
  private scales: Float32Array = new Float32Array(0);
  private glowCanvases: HTMLCanvasElement[] = [];
  private ghostCanvases: HTMLCanvasElement[] = [];
  private coreCanvases: HTMLCanvasElement[] = [];
  private repaint: boolean[] = [];
  private names: { c: HTMLCanvasElement; w: number; h: number }[] = [];
  /* per-person glyph sprites, baked once — 350 path-draws per frame
     become 350 drawImages */
  private dotSprites: HTMLCanvasElement[] = [];
  private spriteK = 2;
  /* person↔person threads, resolved to dot indices at layout time */
  private links: { a: number; b: number; type: RoomEdgeType }[] = [];
  /** Film hues per thread type — resolved from the design tokens at runtime
      (canvas can't follow var(), same story as the fonts). Empty string =
      token missing → that type simply doesn't draw. Never invent a hex. */
  edgeHues: Record<RoomEdgeType, string> = { school: "", company: "", seek: "", why: "" };

  constructor(private adapter: GraphAdapter, private edges: RoomEdge[] = []) {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
  }

  /* returns true when the backing store changed size */
  resize(w: number, h: number, dpr: number): boolean {
    const pw = Math.max(1, Math.floor(w * dpr));
    const ph = Math.max(1, Math.floor(h * dpr));
    /* layout doubles as the initialized flag — a fresh canvas happens
       to be 300×150, which a small embed can legitimately match */
    if (this.layout && this.canvas.width === pw && this.canvas.height === ph) return false;
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.dpr = dpr;
    this.layout = computeLayout(this.adapter.groups(), this.adapter.people(), w, h);
    this.scales = new Float32Array(this.layout.dots.length).fill(1);
    const dotIdx = new Map(this.layout.dots.map((d, i) => [d.person.id, i]));
    this.links = [];
    for (const e of this.edges) {
      const a = dotIdx.get(e.s);
      const b = dotIdx.get(e.t);
      if (a != null && b != null) this.links.push({ a, b, type: e.type });
    }
    this.glowCanvases = this.layout.clusters.map((cl) => {
      const c = document.createElement("canvas");
      c.width = Math.max(2, Math.ceil((cl.board.w / cl.board.scale + GLOW_PAD * 2) * cl.board.scale * GLOW_SCALE));
      c.height = Math.max(2, Math.ceil((cl.board.h / cl.board.scale + GLOW_PAD * 2) * cl.board.scale * GLOW_SCALE));
      return c;
    });
    /* the ghost grid never changes — rasterize it once per board */
    this.ghostCanvases = this.layout.clusters.map((cl) => {
      const b = cl.board;
      const c = document.createElement("canvas");
      c.width = Math.max(2, Math.ceil(b.w * this.dpr));
      c.height = Math.max(2, Math.ceil(b.h * this.dpr));
      const g = c.getContext("2d")!;
      g.scale(this.dpr * b.scale, this.dpr * b.scale);
      g.fillStyle = SEG_OFF;
      for (let col = 0; col < b.cols; col++) {
        const ox = CELL_GAP + col * (CELL_W + CELL_GAP);
        for (let s = 0; s < 16; s++) {
          this.tracePoly(g, CELL_SHAPES[s], ox, CELL_GAP);
          g.fill();
        }
      }
      return c;
    });
    this.coreCanvases = this.layout.clusters.map((cl) => {
      const c = document.createElement("canvas");
      c.width = Math.max(2, Math.ceil(cl.board.w * this.dpr));
      c.height = Math.max(2, Math.ceil(cl.board.h * this.dpr));
      return c;
    });
    this.repaint = this.layout.clusters.map(() => true);
    this.spriteK = this.dpr * 1.7; // headroom for emphasis upscale
    this.dotSprites = this.layout.dots.map((d) => {
      const half = d.baseR * 3.2;
      const size = Math.max(4, Math.ceil(half * 2 * this.spriteK));
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const g = c.getContext("2d")!;
      g.translate(size / 2, size / 2);
      g.scale(this.spriteK, this.spriteK);
      this.paintGlyph(g, d.shape, d.baseR);
      return c;
    });
    this.bakeNames();
    return true;
  }

  /* click targets for the serif group names, in sheet px */
  nameRects(): { x: number; y: number; w: number; h: number }[] {
    const L = this.layout;
    if (!L) return [];
    return L.clusters.map((cl, ci) => {
      const b = cl.board;
      const nm = this.names[ci];
      const w = nm ? nm.w * 0.72 : b.w; // tighter than the baked canvas
      const h = nm ? nm.h * 0.6 : b.h;
      return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
    });
  }

  /* Serif group names: baked once — Hedvig text with a super-slight
     fisheye bulge (vertical slice warp) and a soft horizontal motion
     blur (offset taps). Per frame it's a single faded drawImage.
     Names are never truncated: they wrap onto WHOLE-word lines. */
  bakeNames() {
    const L = this.layout;
    if (!L) return;
    const SS = 2;
    this.names = L.clusters.map((cl) => {
      const b = cl.board;
      const w = Math.ceil(b.w + 48);
      const base = Math.ceil(Math.max(b.h * 2.4, 44));
      /* slightly smaller than the old single-line cap (26): the full name
         earns its room back by wrapping instead of ellipsis-truncating */
      const fs = Math.min(base * 0.46, 22);
      const lineH = fs * 1.16;

      /* greedy fill, measured — a word is never split in half; a single
         word wider than the box keeps its own line and just runs wide */
      const meas = document.createElement("canvas").getContext("2d")!;
      meas.font = `400 ${fs}px ${this.serifFamily}`;
      const words = cl.group.name.toLowerCase().split(/\s+/).filter(Boolean);
      const maxW = w - 16;
      const lines: string[] = [];
      let line = "";
      for (const word of words) {
        const cand = line ? `${line} ${word}` : word;
        if (line && meas.measureText(cand).width > maxW) {
          lines.push(line);
          line = word;
        } else {
          line = cand;
        }
      }
      if (line) lines.push(line);

      const h = Math.ceil(Math.max(base, lines.length * lineH + fs * 0.9));
      const raw = document.createElement("canvas");
      raw.width = w * SS;
      raw.height = h * SS;
      const rc = raw.getContext("2d")!;
      rc.scale(SS, SS);
      rc.font = `400 ${fs}px ${this.serifFamily}`;
      rc.textAlign = "center";
      rc.textBaseline = "middle";
      rc.fillStyle = `rgba(${INK},0.8)`;
      const y0 = h / 2 - ((lines.length - 1) * lineH) / 2;
      lines.forEach((ln, i) => rc.fillText(ln, w / 2, y0 + i * lineH));

      const fx = document.createElement("canvas");
      fx.width = raw.width;
      fx.height = raw.height;
      const fc = fx.getContext("2d")!;
      const slices = 28;
      const barrel = 0.045; // super slight
      const taps = [
        { dx: -1.15 * SS, a: 0.20, blur: 0.7 * SS },
        { dx: 1.15 * SS, a: 0.20, blur: 0.7 * SS },
        { dx: 0, a: 0.75, blur: 0.25 * SS },
      ];
      for (const tap of taps) {
        fc.globalAlpha = tap.a;
        try {
          fc.filter = tap.blur > 0.3 ? `blur(${tap.blur.toFixed(2)}px)` : "none";
        } catch {}
        for (let i = 0; i < slices; i++) {
          const sx = (i / slices) * raw.width;
          const sw = raw.width / slices;
          const u = ((i + 0.5) / slices) * 2 - 1;
          const bulge = 1 + barrel * (1 - u * u);
          const dh = raw.height * bulge;
          const dy = (raw.height - dh) / 2;
          fc.drawImage(raw, sx, 0, sw, raw.height, sx + tap.dx, dy, sw, dh);
        }
      }
      fc.globalAlpha = 1;
      try {
        fc.filter = "none";
      } catch {}
      return { c: fx, w, h };
    });
  }

  draw(f: SheetFrame) {
    const L = this.layout;
    if (!L) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    ctx.fillStyle = CREAM;
    ctx.fillRect(0, 0, L.w, L.h);

    /* camera: screen = (world − cam.xy)·s + viewCentre */
    const cs = f.cam.s;
    ctx.setTransform(
      this.dpr * cs,
      0,
      0,
      this.dpr * cs,
      this.dpr * (L.w / 2 - cs * f.cam.x),
      this.dpr * (L.h / 2 - cs * f.cam.y)
    );

    /* ---- boards ---- */
    L.clusters.forEach((cl, ci) => {
      const board = f.boards[ci];
      const b = cl.board;
      if (!board) {
        ctx.fillStyle = SEG_OFF;
        ctx.beginPath();
        ctx.roundRect(b.x, b.y, b.w, b.h, 4);
        ctx.fill();
        return;
      }
      this.drawBoard(ctx, ci, board, f.boardsDirty[ci]);

      /* serif group name over the resting board — the human voice,
         baked with its slight fisheye + motion blur */
      const na = f.nameAlpha[ci];
      const nm = this.names[ci];
      if (na > 0.01 && nm) {
        ctx.globalAlpha = na;
        ctx.drawImage(
          nm.c,
          b.x + b.w / 2 - nm.w / 2,
          b.y + b.h / 2 - nm.h / 2,
          nm.w,
          nm.h
        );
        ctx.globalAlpha = 1;
      }
    });

    /* ---- dashed group borders — the cloud's edge made legible ---- */
    ctx.save();
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 1 / cs;
    for (let ci = 0; ci < L.clusters.length; ci++) {
      const cl = L.clusters[ci];
      ctx.strokeStyle = `rgba(${INK},${(0.16 + 0.1 * f.nameAlpha[ci]).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(cl.cx, cl.cy, cl.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    /* ---- threads — under the dots, over the boards ---- */
    if (this.links.length) this.drawLinks(ctx, f, cs);

    /* ---- dots ---- */
    const easeK = f.reduced ? 1 : 1 - Math.exp(-f.dt * 10);
    /* visible world rect under the camera, with margin for labels */
    const vMinX = f.cam.x - L.w / 2 / cs - 140;
    const vMaxX = f.cam.x + L.w / 2 / cs + 140;
    const vMinY = f.cam.y - L.h / 2 / cs - 40;
    const vMaxY = f.cam.y + L.h / 2 / cs + 40;
    ctx.font = `500 8.5px ${this.fontFamily}`;
    ctx.textBaseline = "middle";
    L.dots.forEach((d, i) => {
      const hovered = f.hoveredId === d.person.id;
      const target = Math.max(hovered ? 1.4 : 1, f.dotEmphasis(i));
      this.scales[i] += (target - this.scales[i]) * easeK;
      const s = this.scales[i];
      if (d.x < vMinX || d.x > vMaxX || d.y < vMinY || d.y > vMaxY) return;

      const wob = f.reduced ? 0 : 1;
      const x = d.x + Math.sin(f.t * d.speed * 0.9 + d.phase) * 0.55 * wob;
      const y = d.y + Math.cos(f.t * d.speed * 0.7 + d.phase * 1.31) * 0.55 * wob;

      const spr = this.dotSprites[i];
      if (spr) {
        const half = ((spr.width / this.spriteK) * s) / 2;
        ctx.drawImage(spr, x - half, y - half, half * 2, half * 2);
      }

      if (f.focusedId === d.person.id) {
        ctx.strokeStyle = `rgba(${INK},0.5)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, d.baseR * s * 1.9 + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      /* person-name label — placed at layout time so rest labels
         don't collide; culled ones return on hover/focus */
      const la = f.labelFor(i);
      if (la > 0.01) {
        ctx.textAlign = d.labelSide === 1 ? "left" : "right";
        ctx.fillStyle = `rgba(${INK},${(0.55 * la).toFixed(3)})`;
        const lx =
          d.labelSide === 1 ? x + d.baseR * s * 1.8 + 5 : x - d.baseR * s * 1.8 - 5;
        ctx.fillText(d.person.name, lx, y + d.labelDy + 0.5);
      }
    });
  }

  /* Person↔person threads. Batched into one Path2D per (type, emphasis)
     pair so a flooded room is a handful of strokes, not 1600. Each thread
     bows slightly perpendicular to its chord — a thread, not a wire. */
  private drawLinks(ctx: CanvasRenderingContext2D, f: SheetFrame, cs: number) {
    const L = this.layout!;
    const focusId = f.focusedId ?? f.hoveredId;
    const paths = new Map<string, Path2D>();
    const trace = (key: string, ax: number, ay: number, bx: number, by: number) => {
      let p = paths.get(key);
      if (!p) {
        p = new Path2D();
        paths.set(key, p);
      }
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(18, len * 0.08);
      p.moveTo(ax, ay);
      p.quadraticCurveTo(mx - (dy / len) * bow, my + (dx / len) * bow, bx, by);
    };

    const anyFocus = !!focusId;
    for (const lk of this.links) {
      const A = L.dots[lk.a];
      const B = L.dots[lk.b];
      const ego = anyFocus && (A.person.id === focusId || B.person.id === focusId);
      if (!ego && !f.edgeOn[lk.type]) continue;
      trace(`${lk.type}:${ego ? "e" : "r"}`, A.x, A.y, B.x, B.y);
    }

    ctx.save();
    ctx.lineCap = "round";
    for (const [key, path] of paths) {
      const [type, kind] = key.split(":") as [RoomEdgeType, "e" | "r"];
      const hue = this.edgeHues[type];
      if (!hue) continue; // token missing — stay silent rather than invent a hue
      const ego = kind === "e";
      const wpx = (ego ? 2 : 1) / cs;
      if (ego) {
        /* ink under-stroke: the film hues are pastels and sink into the
           cream on their own — the ink gives the thread its spine, the
           hue keeps its voice */
        ctx.globalAlpha = f.focusedId ? 0.18 : 0.12;
        ctx.strokeStyle = `rgba(${INK},1)`;
        ctx.lineWidth = wpx + 0.8 / cs;
        ctx.stroke(path);
      }
      /* a focused person's threads read at full voice; the room-wide flood
         recedes further while someone is focused so the ego web pops */
      ctx.globalAlpha = ego ? (f.focusedId ? 0.9 : 0.62) : anyFocus ? 0.06 : 0.16;
      ctx.strokeStyle = hue;
      ctx.lineWidth = wpx;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  private drawBoard(
    ctx: CanvasRenderingContext2D,
    ci: number,
    board: BoardState,
    dirty: boolean
  ) {
    const L = this.layout!;
    const cl = L.clusters[ci];
    const b = cl.board;
    const sc = b.scale;

    /* off-state ghost grid — cached raster, one blit */
    ctx.drawImage(this.ghostCanvases[ci], b.x, b.y, b.w, b.h);

    /* repaint glow + core only when the board's arrays changed
       (BoardState gates itself to 30fps; static text repaints at
       most when the palette drifts) */
    if (dirty || this.repaint[ci]) {
      this.repaint[ci] = false;

      /* glow pass — low-res canvas, bilinear upscale is the blur */
      const glow = this.glowCanvases[ci];
      const gctx = glow.getContext("2d")!;
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.clearRect(0, 0, glow.width, glow.height);
      const gs = sc * GLOW_SCALE;
      gctx.setTransform(gs, 0, 0, gs, GLOW_PAD * gs, GLOW_PAD * gs);

      const core = this.coreCanvases[ci];
      const cctx = core.getContext("2d")!;
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, core.width, core.height);
      cctx.setTransform(this.dpr * sc, 0, 0, this.dpr * sc, 0, 0);

      for (let c = 0; c < b.cols; c++) {
        const ox = CELL_GAP + c * (CELL_W + CELL_GAP);
        for (let s = 0; s < 16; s++) {
          const i = c * 16 + s;
          const v = board.values[i];
          if (v < 0.01) continue;
          const r = board.colors[i * 3],
            g = board.colors[i * 3 + 1],
            bl = board.colors[i * 3 + 2];
          const a = Math.min(1, v * (0.5 + board.sheens[i] * 0.7));
          gctx.fillStyle = `rgba(${r},${g},${bl},${a.toFixed(3)})`;
          this.tracePoly(gctx, CELL_SHAPES[s], ox, CELL_GAP);
          gctx.fill();
          cctx.fillStyle = `rgba(${r},${g},${bl},${v.toFixed(3)})`;
          this.tracePoly(cctx, CELL_SHAPES[s], ox, CELL_GAP);
          cctx.fill();
        }
      }
    }

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.globalAlpha = 0.85;
    ctx.drawImage(
      this.glowCanvases[ci],
      b.x - GLOW_PAD * sc,
      b.y - GLOW_PAD * sc,
      this.glowCanvases[ci].width / GLOW_SCALE,
      this.glowCanvases[ci].height / GLOW_SCALE
    );
    ctx.restore();
    ctx.drawImage(this.coreCanvases[ci], b.x, b.y, b.w, b.h);
  }

  /* the generative dot: rect-class base at centre, round accent
     upper-right, unique accent lower-left. r is the base half-size.
     Painted once per person into a sprite at resize. */
  private paintGlyph(
    ctx: CanvasRenderingContext2D,
    shape: { rect: number; round: number; uniq: number; rot: number },
    r: number
  ) {
    const { rect, round, uniq, rot } = shape;
    const TAU2 = Math.PI * 2;
    ctx.save();
    ctx.rotate(rot);
    ctx.fillStyle = `rgba(${INK},0.92)`;
    ctx.strokeStyle = `rgba(${INK},0.92)`;

    /* base: square | squircle | tall rect | diamond */
    ctx.beginPath();
    if (rect === 0) ctx.rect(-r, -r, 2 * r, 2 * r);
    else if (rect === 1) ctx.roundRect(-r, -r, 2 * r, 2 * r, r * 0.5);
    else if (rect === 2) ctx.rect(-r * 0.62, -r * 1.3, r * 1.24, r * 2.6);
    else {
      ctx.moveTo(0, -r * 1.25);
      ctx.lineTo(r * 1.25, 0);
      ctx.lineTo(0, r * 1.25);
      ctx.lineTo(-r * 1.25, 0);
      ctx.closePath();
    }
    ctx.fill();

    /* round accent: dot | ring | half-moon */
    const ox = r * 1.2, oy = -r * 1.2, rr = r * 0.55;
    ctx.beginPath();
    if (round === 0) {
      ctx.arc(ox, oy, rr, 0, TAU2);
      ctx.fill();
    } else if (round === 1) {
      ctx.lineWidth = Math.max(0.7, r * 0.3);
      ctx.arc(ox, oy, rr, 0, TAU2);
      ctx.stroke();
    } else {
      ctx.arc(ox, oy, rr, Math.PI * 0.25, Math.PI * 1.25);
      ctx.fill();
    }

    /* unique accent: sparkle | plus | asterisk | triangle */
    const ux = -r * 1.25, uy = r * 1.25, ur = r * 0.66;
    ctx.beginPath();
    if (uniq === 0) {
      ctx.moveTo(ux, uy - ur);
      ctx.quadraticCurveTo(ux, uy, ux + ur, uy);
      ctx.quadraticCurveTo(ux, uy, ux, uy + ur);
      ctx.quadraticCurveTo(ux, uy, ux - ur, uy);
      ctx.quadraticCurveTo(ux, uy, ux, uy - ur);
      ctx.fill();
    } else if (uniq === 1) {
      const t = Math.max(0.7, r * 0.32);
      ctx.rect(ux - ur, uy - t / 2, ur * 2, t);
      ctx.rect(ux - t / 2, uy - ur, t, ur * 2);
      ctx.fill();
    } else if (uniq === 2) {
      ctx.lineWidth = Math.max(0.7, r * 0.28);
      for (let a = 0; a < 3; a++) {
        const th = (a * Math.PI) / 3;
        ctx.moveTo(ux - Math.cos(th) * ur, uy - Math.sin(th) * ur);
        ctx.lineTo(ux + Math.cos(th) * ur, uy + Math.sin(th) * ur);
      }
      ctx.stroke();
    } else {
      ctx.moveTo(ux, uy - ur);
      ctx.lineTo(ux + ur * 0.87, uy + ur * 0.5);
      ctx.lineTo(ux - ur * 0.87, uy + ur * 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private tracePoly(
    ctx: CanvasRenderingContext2D,
    shape: [number, number][],
    ox: number,
    oy: number
  ) {
    ctx.beginPath();
    ctx.moveTo(shape[0][0] + ox, shape[0][1] + oy);
    for (let k = 1; k < shape.length; k++) {
      ctx.lineTo(shape[k][0] + ox, shape[k][1] + oy);
    }
    ctx.closePath();
  }
}
