/* Board state machine — the morph machinery the choreography drives.
   Three modes:
     text          — spells a string, one char per cell
     field         — runs a field animation
     morph(a → b)  — per-segment crossfade routed THROUGH a field:
                     each segment leaves its glyph into weather and
                     re-condenses into the new glyph, staggered by
                     hash2(cell, seg).
   Values/colors are computed at a 30fps gate into flat arrays the
   sheet renderer consumes every frame. */

import { clamp01, hash2, lerp, smoothstep } from "./prng";
import {
  CELL_W,
  CELL_H,
  CELL_GAP,
  SEG_CENTROIDS,
  FIELDS,
  FieldName,
  filmColor,
  maskFor,
} from "./segments";

export type MorphOpts = {
  duration: number; // ms, whole morph
  fieldHold: number; // ms of pure field in the middle
};

const FRAME_MS = 1000 / 30;
const STAGGER = 0.22;

export class BoardState {
  cols: number;
  aspect: number;

  /* flat per-(cell,seg): brightness, rgb, sheen */
  values: Float32Array;
  colors: Uint8Array;
  sheens: Float32Array;

  fieldName: FieldName = "weather";

  /* hover glow: while a group title is hovered, its board's field
     blooms in lightly and blobbily under the resting text. 0..1,
     eased by the component. */
  hoverGain = 0;

  private mode: "text" | "field" | "morph" = "text";
  private text = "";
  private masks: number[] = [];
  private morphFrom: number[] = [];
  private morphTo: number[] = [];
  private morphStart = 0;
  private morphDur = 900;
  private morphHold = 300;
  private afterMorph: "text" | "field" = "text";
  private lastFrame = -1e9;
  private jitter: Float32Array;

  constructor(cols: number) {
    this.cols = cols;
    const bw = cols * (CELL_W + CELL_GAP) + CELL_GAP;
    const bh = CELL_H + CELL_GAP * 2;
    this.aspect = bw / bh;
    const n = cols * 16;
    this.values = new Float32Array(n);
    this.colors = new Uint8Array(n * 3);
    this.sheens = new Float32Array(n);
    this.jitter = new Float32Array(n);
    for (let i = 0; i < n; i++) this.jitter[i] = (hash2(i * 1.7, 3.1) - 0.5) * 0.14;
  }

  private masksFor(text: string): number[] {
    /* centre the string on the board */
    const pad = Math.max(0, Math.floor((this.cols - text.length) / 2));
    const m: number[] = [];
    for (let c = 0; c < this.cols; c++) m.push(maskFor(text[c - pad] ?? " "));
    return m;
  }

  setText(text: string) {
    this.text = text;
    this.masks = this.masksFor(text);
    this.mode = "text";
    this.lastFrame = -1e9;
  }

  setField(name: FieldName) {
    this.fieldName = name;
    this.mode = "field";
    this.lastFrame = -1e9;
  }

  get currentText() {
    return this.text;
  }
  get isMorphing() {
    return this.mode === "morph";
  }

  /* dissolve current state into the field, re-condense into `text`.
     If `text` equals the current text this is the resting "breathe". */
  morphToText(text: string, now: number, opts: MorphOpts, reduced: boolean) {
    if (reduced) {
      this.setText(text);
      return;
    }
    this.morphFrom = this.snapshotMasks();
    this.text = text;
    this.masks = this.masksFor(text);
    this.morphTo = this.masks.slice();
    this.morphStart = now;
    this.morphDur = Math.max(120, opts.duration);
    this.morphHold = Math.min(opts.fieldHold, this.morphDur * 0.8);
    this.afterMorph = "text";
    this.mode = "morph";
    this.lastFrame = -1e9;
  }

  /* dissolve into pure field mode (approach state) */
  morphToField(name: FieldName, now: number, opts: MorphOpts, reduced: boolean) {
    this.fieldName = name;
    if (reduced) {
      this.setField(name);
      return;
    }
    this.morphFrom = this.snapshotMasks();
    this.morphTo = this.masksFor(""); // irrelevant — we stop at the field
    this.morphStart = now;
    this.morphDur = Math.max(120, opts.duration);
    this.morphHold = 0; // the whole duration is the dissolve into the field
    this.afterMorph = "field";
    this.mode = "morph";
    this.lastFrame = -1e9;
  }

  private snapshotMasks(): number[] {
    /* a bloomed (hovered) board must fall through to value
       thresholding, or the bloom hard-cuts when a breathe starts */
    if (this.mode === "text" && this.hoverGain <= 0.01) return this.masks.slice();
    /* leaving a field or mid-morph: treat current values as the "from"
       by thresholding — segments currently bright count as set */
    const m: number[] = [];
    for (let c = 0; c < this.cols; c++) {
      let mask = 0;
      for (let s = 0; s < 16; s++) {
        if (this.values[c * 16 + s] > 0.5) mask |= 1 << s;
      }
      m.push(mask);
    }
    return m;
  }

  /* recompute arrays; gated to 30fps. `now` in ms, `t` in seconds.
     Returns true when the arrays were recomputed (renderer repaints). */
  update(now: number, t: number, reduced: boolean): boolean {
    /* a hovered (or fading) board must keep recomputing even in
       static text mode, so the bloom animates */
    if (now - this.lastFrame < FRAME_MS) return false;
    this.lastFrame = now;

    const field = FIELDS[this.fieldName];
    const D = this.morphDur;
    const holdFrac = this.morphHold / D;
    /* a morph that lands on a field spends its whole duration dissolving */
    const edge =
      this.mode === "morph" && this.afterMorph === "field"
        ? 1
        : Math.max(0.05, (1 - holdFrac) / 2);
    const tNorm = clamp01((now - this.morphStart) / D);

    if (this.mode === "morph" && tNorm >= 1) {
      this.mode = this.afterMorph;
    }

    for (let c = 0; c < this.cols; c++) {
      /* board-space position of each segment */
      const ox = CELL_GAP + c * (CELL_W + CELL_GAP);
      const bw = this.cols * (CELL_W + CELL_GAP) + CELL_GAP;
      const bh = CELL_H + CELL_GAP * 2;
      const mask = this.masks[c] ?? 0;

      for (let s = 0; s < 16; s++) {
        const i = c * 16 + s;
        const x = (SEG_CENTROIDS[s][0] + ox) / bw;
        const y = (SEG_CENTROIDS[s][1] + CELL_GAP) / bh;

        let v: number;
        if (this.mode === "text") {
          v = mask & (1 << s) ? 1 : 0;
          if (this.hoverGain > 0.01) {
            /* the hover bloom rides the field, scaled down */
            v = Math.max(v, field(x, y, t, c, s, this.aspect) * this.hoverGain);
          }
        } else if (this.mode === "field") {
          v = field(x, y, t, c, s, this.aspect);
        } else {
          const fromV = this.morphFrom[c] & (1 << s) ? 1 : 0;
          const toV = this.morphTo[c] & (1 << s) ? 1 : 0;
          const fieldV = field(x, y, t, c, s, this.aspect);
          /* per-segment stagger: staggered start, shared finish */
          const stag = hash2(c * 1.31, s * 2.7) * STAGGER;
          const tp = clamp01((tNorm * (1 + stag) - stag));
          if (tp < edge) {
            v = lerp(fromV, fieldV, smoothstep(0, 1, tp / edge));
          } else if (tp < 1 - edge || this.afterMorph === "field") {
            v = fieldV;
          } else {
            v = lerp(fieldV, toV, smoothstep(0, 1, (tp - (1 - edge)) / edge));
          }
        }

        v = clamp01(v + v * this.jitter[i]);
        this.values[i] = v;

        if (v > 0.01) {
          const fc = filmColor(x, y, t, this.aspect);
          this.colors[i * 3] = fc.r;
          this.colors[i * 3 + 1] = fc.g;
          this.colors[i * 3 + 2] = fc.b;
          this.sheens[i] = fc.sheen;
        }
      }
    }
    return true;
  }
}
