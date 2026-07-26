"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { defaultAdapter, ROOM_EDGES, type RoomEdgeType } from "./adapter";
import { GUEST_DETAILS } from "./adapter";
import StampBurst, { type StampData } from "./Stamps";
import HometownMap from "./HometownMap";
import TagTicker, { TICKER_HEIGHT } from "./TagTicker";
import ConnectionsLegend from "./ConnectionsLegend";
import { GraphSheet } from "./sheet";
import { BoardState } from "./boards";
import { Choreography, FocusedPerson } from "./choreo";
import { BUBBLE_FRAG, BUBBLE_UNIFORMS } from "./shaders";
import {
  KUWAHARA_FRAG,
  TENSOR_FRAG,
  ANISO_KUWAHARA_FRAG,
  GRADE_FRAG,
  FINISH_FRAG,
} from "./monet";
import {
  compileProgram,
  uniformMap,
  makeTexture,
  makeTarget,
  destroyTarget,
  bindFullscreenTriangle,
  QUAD_VERT,
  RenderTarget,
} from "./webgl";
import { mulberry32 } from "./prng";
import type { FieldName } from "./segments";

/* The full stack: graph sheet → bubble lens → Monet chain.
   Passes: scene (lens) → Kuwahara (half res) → composite+grade →
   impasto+weave+grain. Layering order is fixed. */

export const DEFAULTS = {
  // lens — warp low: the rim should barely smear. The radius is the
  // UNPOPPED bubble (holding the whole room); after the first click pops
  // it, it returns at POPPED_SCALE of this. Values are Teri's tuning
  // (2026-07-25 panel screenshot): max-size lens, gentle magnify.
  zoom: 1.35, warp: 0.1,
  // film
  thick: 380, drain: 0.55, chroma: 1.0, edge: 0.62, turb: 0.3, flow: 0.35, back: 0.45,
  // form
  radius: 0.46, wobble: 0.018, surface: 0.016,
  // motion — the bubble sits in the middle; wander is off by default
  gravity: 0.0, drag: 3.4, wander: 0,
  jiggle: 1.6, settle: 1.0, squish: -1.2, bounce: 0.30, grip: 0.25,
  // morph timing — the feel of the whole piece
  morphDur: 900, morphHold: 300, hopDur: 350, hopHold: 140,
  // monet — weave is gone (it read as scan lines at any period); grain
  // is drawn by the DOM veil so it covers the widgets too
  kuwahara: 0.85, kuwaKernel: 2.4, grade: 0.65, impasto: 0.4, grain: 0.16,
  // scale — north-star Addendum 5: "the scale of the actual card items can be
  // scaled to be slightly larger and the bubble as well". Two live handles
  // behind the hidden 0-key menu, and 1 is the room exactly as designed, so
  // they are inert until someone drags them. Each multiplies ONE existing
  // number and nothing else: cardScale raises the stamp burst's intrinsic
  // ceiling (the viewport-fit terms still bind — see the burst transform),
  // bubbleScale multiplies the lens radius (pre-pop clamped, see
  // MAX_LENS_RADIUS). Sliders stop at 1.6; "slightly larger" is ~1.1–1.3.
  cardScale: 1, bubbleScale: 1,
};

export type Params = typeof DEFAULTS & {
  field: FieldName;
  exportQuality: boolean;
};

const INITIAL: Params = { ...DEFAULTS, field: "weather", exportQuality: false };

const MAX_DEFORM = 0.3;
/* the scene camera is the zoom; the bubble is a draggable lens toy
   that lives in the middle and never flies to targets */
const SCENE_ZOOM_PERSON = 2.2;
/* after the first click pops the bubble it returns at this ABSOLUTE radius
   (mn units) — a toy, no longer the room's container. 0.135 is Teri's call. */
const POPPED_RADIUS = 0.135;
/* the ceiling on the UNPOPPED lens. That default radius already IS the
   max-size room container (it is the radius slider's max as well), so
   bubbleScale may only grow the popped toy past it — a pre-pop bubble wider
   than this stops holding the room and starts overflowing its framing. */
const MAX_LENS_RADIUS = DEFAULTS.radius;
/* the UNPOPPED lens radius the scene actually renders with — the one place the
   scaled-and-clamped product is spelled. Both the frame loop's targetR and the
   camera-home fit read it, because a fit computed off the raw slider would frame
   the room to a bubble that is not the one on screen. */
const unpoppedLensR = (p: Params) => Math.min(p.radius * p.bubbleScale, MAX_LENS_RADIUS);
/* movement (shader units) past which a press is a PAN, not a click/pop */
const PAN_START = 0.02;
/* the wobble a press is allowed before it stops being a click. Below it a
   release still selects; above it, a press that started on a dot is CARRYING
   that dot. Deliberately under PAN_START, so a press on a dot always becomes
   a dot drag before it could ever have become a camera pan. */
const CLICK_SLOP = 0.012;

/* ---- the focus veil (Johnny's pinned treatment) --------------------------
   "when we click on it, it should smoothly blur out the background so we can
   focus on the things that popped up… extremely subtle with a slight 5%
   dimming." One pointer-events:none sheet laid over the WebGL room. Three
   things about it are load-bearing:

   (a) THE NUMBERS LIVE HERE and nowhere else — an ink wash at 5%
       (rgba(38,36,44,·), the pepl ink family) over a 2.2px backdrop blur,
       cross-faded across VEIL_MS. Grep "focus veil" and this is the only hit
       that decides how dim "5% dimming" is.
   (b) THE VEIL SOFTENS THE ROOM AND NOTHING ELSE: it is a DOM sibling placed
       directly AFTER the canvas wrap, so everything that pops — the stamp
       burst, ticker, hometown map, connections legend, their-threads widget,
       receipts, search, index, logo, and the GrainVeil (still last) — must
       stay a sibling after it in source order, i.e. painted above it, i.e.
       sharp. Adding a widget before the veil silently blurs it.
   (c) Boolean(focusKey) — the same stamps.on signal the burst rides — is the
       SINGLE input. Select and deselect therefore cross-fade together, and no
       other state may reach in and toggle the veil.

   (d) THE BUBBLE IS THE CLARITY LENS — a TWO-STATE model, pinned verbatim.
       Addendum 3: "for the blur, make sure whatever the bubble hovers on it
       converts that section into full clairty." Addendum 4: "so basically for
       more clairty on the bubble. when we are in a zoomed out view. eveyrhting
       should be crystal clear and the buble just does the edge effect. but
       when you select on one individual whatever is in the buble will recieve
       the full calirty." Therefore:
       · REST (no selection) — no veil, so the lens is STRICTLY INERT: the mask
         is not attached and the frame loop writes nothing (`veilLiveRef`). The
         room is crystal; the bubble contributes only its own edge effect.
       · SELECTED — the veil's alpha is cut out over the bubble's screen circle,
         so BOTH the 5% ink and the 2.2px backdrop blur stop at the glass and
         the softened room reads sharp through it, wherever it is dragged.
       Mechanism: ONE static radial-gradient mask parameterised by three custom
       properties written per frame (--lens-x/--lens-y/--lens-r) — no gradient
       string is rebuilt, and the write rides the same imperative-DOM-from-the-
       frame-loop path as the stamp anchor. The feather sits INSIDE the radius
       so the clear disc can never spill past a wobbling or squished rim; it
       lands in the shader's own rim band, which is why the edge reads as the
       glass refracting rather than a cut hole. During the pop burst lensR runs
       to 0 and back, so the hole shrinks to nothing and regrows with it.
       A/B'd in Chromium (2026-07-25): mask-image clips the backdrop-filtered
       region as well as the painted background, so one sheet carries both. An
       engine that masked only the ink would need two stacked masked sheets —
       a half-hole must never ship silently.

   The focused dot and its neighbours are painted IN the canvas and so soften
   with the room; at 2.2px that is imperceptible on a dot, and the one sharp
   window the room gets is the bubble itself. Idle cost is zero: a full-viewport
   backdrop-filter over a 60fps canvas is paid every frame, so the blur AND the
   lens mask are attached only while the veil is alive (see `veilMounted`). */
const VEIL_DIM = 0.05;
const VEIL_BLUR_PX = 2.2;
const VEIL_MS = 480;
/* how far inside the rim the clarity hole feathers back to veiled. ~the
   shader's rim band (d 0.84–1.0) at the popped radius on a laptop. */
const LENS_FEATHER_PX = 18;
const LENS_MASK =
  `radial-gradient(circle at var(--lens-x) var(--lens-y), transparent 0 ` +
  `max(0px, calc(var(--lens-r) - ${LENS_FEATHER_PX}px)), #000 var(--lens-r))`;

/** A baked person record (public/graph/people/<id>.json) — fetched on focus for
    the relationships widget. The stamps do not read it: they are composed from
    graph.json at pop time so nothing on a stamp arrives late or changes. */
type PersonRecord = {
  personId: string;
  name: string;
  answers?: Record<string, string>;
  edges?: {
    targetId: string;
    type: string;
    direction?: "mutual" | "inbound" | "outbound";
    strength?: number;
    via: string;
    receipt?: {
      yours?: { field: string; quote: string };
      theirs?: { field: string; quote: string };
    };
  }[];
  highlights?: { kind: string; text: string; targets?: string[] }[];
};

/** widget row sections, in speaking order */
const REL_SECTIONS: { key: string; title: string; match: (e: NonNullable<PersonRecord["edges"]>[number]) => boolean }[] = [
  { key: "mutual", title: "You are looking for each other", match: (e) => e.direction === "mutual" },
  { key: "inbound", title: "They are looking for you", match: (e) => e.direction === "inbound" },
  { key: "outbound", title: "You are looking for them", match: (e) => e.direction === "outbound" },
  { key: "why", title: "Shared conviction", match: (e) => e.type === "why" },
  { key: "school", title: "Same school", match: (e) => e.type === "school" },
  { key: "company", title: "Same company", match: (e) => e.type === "company" },
];

/* ---- tune panel definition (Bubble.jsx style) ---- */
const PANEL_GROUPS: {
  name: string;
  items: { key: keyof typeof DEFAULTS; label: string; min: number; max: number; step: number; unit?: string }[];
}[] = [
  /* first group on purpose: this is the menu Addendum 5 asked for, and the
     0 key opens the panel onto it without a scroll. Floor is 1 — the ask was
     "slightly larger", and below 1 is just the shipped design made worse. */
  { name: "scale", items: [
    { key: "cardScale", label: "cards", min: 1, max: 1.6, step: 0.01 },
    { key: "bubbleScale", label: "bubble", min: 1, max: 1.6, step: 0.01 },
  ]},
  { name: "lens", items: [
    { key: "zoom", label: "magnify", min: 1, max: 3.5, step: 0.05 },
    { key: "warp", label: "fisheye", min: 0, max: 1.2, step: 0.01 },
    { key: "radius", label: "radius", min: 0.12, max: MAX_LENS_RADIUS, step: 0.005 },
  ]},
  { name: "morph", items: [
    { key: "morphDur", label: "duration", min: 200, max: 2400, step: 20, unit: "ms" },
    { key: "morphHold", label: "field hold", min: 0, max: 1200, step: 20, unit: "ms" },
    { key: "hopDur", label: "hop", min: 120, max: 900, step: 10, unit: "ms" },
    { key: "hopHold", label: "hop hold", min: 0, max: 500, step: 10, unit: "ms" },
  ]},
  { name: "monet", items: [
    { key: "kuwahara", label: "kuwahara", min: 0, max: 1, step: 0.01 },
    { key: "kuwaKernel", label: "kernel", min: 1, max: 3, step: 0.05 },
    { key: "grade", label: "grade", min: 0, max: 1, step: 0.01 },
    { key: "impasto", label: "impasto", min: 0, max: 1, step: 0.01 },
    { key: "grain", label: "grain", min: 0, max: 0.5, step: 0.005 },
  ]},
  { name: "film", items: [
    { key: "thick", label: "thickness", min: 120, max: 900, step: 1, unit: "nm" },
    { key: "drain", label: "drain", min: 0, max: 0.95, step: 0.01 },
    { key: "chroma", label: "chroma", min: 0, max: 1.8, step: 0.01 },
    { key: "edge", label: "colour edge", min: 0, max: 0.97, step: 0.01 },
    { key: "turb", label: "turbulence", min: 0, max: 1.5, step: 0.005 },
    { key: "flow", label: "flow", min: 0, max: 3, step: 0.01 },
    { key: "back", label: "far wall", min: 0, max: 1, step: 0.01 },
  ]},
  { name: "form", items: [
    { key: "wobble", label: "silhouette", min: 0, max: 0.16, step: 0.001 },
    { key: "surface", label: "undulation", min: 0, max: 0.16, step: 0.001 },
  ]},
  { name: "motion", items: [
    { key: "gravity", label: "gravity", min: 0, max: 1.2, step: 0.01 },
    { key: "drag", label: "viscosity", min: 0.2, max: 8, step: 0.05 },
    { key: "wander", label: "wander", min: 0, max: 3, step: 0.02 },
    { key: "grip", label: "grip", min: 0.05, max: 2, step: 0.01 },
    { key: "jiggle", label: "response hz", min: 0.4, max: 7, step: 0.05 },
    { key: "settle", label: "settle", min: 0.05, max: 1.4, step: 0.01 },
    { key: "squish", label: "squish", min: -6, max: 6, step: 0.05 },
    { key: "bounce", label: "bounce", min: 0, max: 0.9, step: 0.01 },
  ]},
];

/* The grain veil — the film's last pass, moved OUT of the WebGL chain and into
   the DOM. The ticker, map, pills and logo are DOM siblings the shader can
   never touch; a fixed canvas as the LAST child of the shell grains all of
   them and the scene alike. hard-light around exact 50% grey is an identity,
   so the veil only ever adds the speckle, never a wash. Stepped ~12fps like
   the shader grain was; pointer-events stay off so it can never eat a click. */
function GrainVeil({ paramsRef }: { paramsRef: React.MutableRefObject<Params> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);

    /* a few pre-baked per-channel noise tiles, cycled with a drifting
       anchor — regenerating full-viewport noise per step would be the
       expensive way to draw the same thing */
    const TILE = 224;
    const rng = mulberry32(1913);
    const tiles = Array.from({ length: 4 }, () => {
      const t = document.createElement("canvas");
      t.width = TILE;
      t.height = TILE;
      const tc = t.getContext("2d")!;
      const img = tc.createImageData(TILE, TILE);
      for (let p = 0; p < img.data.length; p += 4) {
        img.data[p] = 128 + (rng() - 0.5) * 116;
        img.data[p + 1] = 128 + (rng() - 0.5) * 116;
        img.data[p + 2] = 128 + (rng() - 0.5) * 116;
        img.data[p + 3] = 255;
      }
      tc.putImageData(img, 0, 0);
      return t;
    });

    const resize = () => {
      const r = canvas.parentElement?.getBoundingClientRect();
      canvas.width = Math.max(2, Math.floor((r?.width ?? 2) * dpr));
      canvas.height = Math.max(2, Math.floor((r?.height ?? 2) * dpr));
      lastStep = -1; // repaint at the new size on the next frame
    };
    let lastStep = -1;
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const paint = (step: number) => {
      const pat = ctx.createPattern(tiles[step % tiles.length], "repeat");
      if (!pat) return;
      const ox = (step * 61) % TILE;
      const oy = (step * 97) % TILE;
      ctx.setTransform(1, 0, 0, 1, -ox, -oy);
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, canvas.width + TILE, canvas.height + TILE);
    };

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const g = paramsRef.current.grain;
      /* the slider stays live: it now drives the veil's opacity */
      canvas.style.opacity = Math.min(1, g * 1.5).toFixed(3);
      if (g <= 0) return;
      /* frozen grain for reduced motion — texture without the flicker */
      const step = reduced ? 0 : Math.floor(performance.now() * 0.012);
      if (step === lastStep) return;
      lastStep = step;
      paint(step);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [paramsRef]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        mixBlendMode: "hard-light",
      }}
    />
  );
}

export default function PeplGraph() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Popped = the lens is gone and the room is released to full size. */
  const poppedRef = useRef(false);
  const [popped, setPopped] = useState(false);
  const [stamps, setStamps] = useState<(StampData & { on: boolean }) | null>(null);
  const stampsRef = useRef<HTMLDivElement>(null);
  const stampsLiveRef = useRef<(StampData & { on: boolean }) | null>(null);
  /* a second, frozen-in-place burst that peels while the next pops */
  const [peeling, setPeeling] = useState<
    (StampData & { at: { x: number; y: number; k: number } }) | null
  >(null);
  const peelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (peelTimerRef.current) clearTimeout(peelTimerRef.current);
    },
    []
  );

  /* peeled-off stamps unmount after their exit animation */
  useEffect(() => {
    if (stamps && !stamps.on) {
      const timer = setTimeout(() => setStamps(null), 700);
      return () => clearTimeout(timer);
    }
  }, [stamps]);
  const [indexOpen, setIndexOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  /* the tune panel is a design tool, not a party surface — hidden unless
     the URL opts in with ?tune=1, or the 0 key asks for it (below) */
  const [tuneVisible, setTuneVisible] = useState(false);

  /* ---- the hidden 0-key menu (north-star Addendum 5: "if we have a hidden
     command when we press 0 it should open this new menu") ----------------
     One window listener, no affordance: the panel a guest can never find is
     the one with nothing on screen pointing at it, so pressing 0 has to raise
     BOTH the pill and the panel, and closing has to put both back down. The
     one exception is ?tune=1 — that opt-in owns the pill for the session, so
     a close leaves the pill where the URL asked for it. `togglePanel` IS that
     rule: the pill's own "hide" is the same close as the 0 key and calls it,
     so there is no second path that can leave the pill up on its own.

     The guards are the whole risk here. This fires on window, and the search
     box is one Tab away: a 0 typed into any field, or committed by an IME, is
     text and never a command. Meta/ctrl/alt are held for the browser's own
     shortcuts. Shift needs no test — shift+0 arrives as ")". Range inputs are
     the one exception to the field rule, and they are exactly the sliders in
     this panel: they take no text, so 0 has to keep closing the menu for
     someone who just finished dragging one. */
  const togglePanel = useCallback(() => {
    const opening = !panelOpen;
    setPanelOpen(opening);
    /* read live, not at mount: the URL is the session's opt-in */
    setTuneVisible(
      opening || new URLSearchParams(window.location.search).get("tune") === "1"
    );
  }, [panelOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "0" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "TEXTAREA" ||
          el.isContentEditable ||
          (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "range"));
      if (typing) return;
      e.preventDefault();
      togglePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel]);

  /* the focused person's baked record — their ranked relationships with
     receipts, for the threads widget */
  const [profile, setProfile] = useState<PersonRecord | null>(null);
  const [receiptOpen, setReceiptOpen] = useState<number | null>(null);
  const profileCache = useRef(new Map<string, PersonRecord>());
  const focusKey = stamps?.on ? stamps.personKey : null;
  /* the focus veil's only input, and its mount life (constraint note at
     VEIL_DIM): on the instant a person is focused, off only once the fade-out
     has finished — the blur must never stay attached to an idle canvas */
  const veilOn = Boolean(focusKey);
  const [veilMounted, setVeilMounted] = useState(false);
  useEffect(() => {
    if (veilOn) {
      setVeilMounted(true);
      return;
    }
    const t = setTimeout(() => setVeilMounted(false), VEIL_MS + 80);
    return () => clearTimeout(t);
  }, [veilOn]);
  /* the clarity lens's handle + gate (law (d)): the frame loop writes the hole
     only while the mask is actually attached, so rest state costs nothing */
  const veilRef = useRef<HTMLDivElement>(null);
  const veilLiveRef = useRef(false);
  useEffect(() => {
    veilLiveRef.current = veilMounted;
  }, [veilMounted]);
  useEffect(() => {
    setReceiptOpen(null);
    if (!focusKey) {
      setProfile(null);
      return;
    }
    const cached = profileCache.current.get(focusKey);
    if (cached) {
      setProfile(cached);
      return;
    }
    setProfile(null);
    let gone = false;
    fetch(`/graph/people/${focusKey}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<PersonRecord>) : null))
      .then((rec) => {
        if (gone || !rec) return;
        profileCache.current.set(focusKey, rec);
        setProfile(rec);
      })
      .catch(() => {}); // widget just stays empty — the room owes no error UI
    return () => {
      gone = true;
    };
  }, [focusKey]);

  /* The stamps used to be patched from this record once it landed — hometown out
     of the kind-keyed highlight, plus the favourite film. Both are gone: the
     hometown is a baked node field now (it reads at pop time, for all 311 who
     answered, instead of the 195 whose record kept the highlight after the
     6-highlight cap), and a stamp that pops before its own text arrives is a
     stamp that visibly changes its mind. The burst is composed from graph.json
     only; this record is the threads widget's. */
  const [params, setParams] = useState<Params>(INITIAL);
  const [query, setQuery] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);

  const paramsRef = useRef<Params>(INITIAL);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  /* thread-legend toggles: which connection types flood the whole room.
     A focused person's own threads always draw. `why` starts on — the
     conviction web is the room's grammar; the denser structural types
     are opt-in. */
  const [edgeOn, setEdgeOn] = useState<Record<RoomEdgeType, boolean>>({
    school: false,
    company: false,
    seek: false,
    why: true,
  });
  const edgeOnRef = useRef(edgeOn);
  useEffect(() => {
    edgeOnRef.current = edgeOn;
  }, [edgeOn]);

  /* the DOM overlays are opt-in: the room spawns as the bubble and nothing
     else. One flat record, one pill each — no persistence, no provider; a
     toggle is only a toggle. Hiding `connections` hides the box, never the
     threads it switched on. */
  const [widgets, setWidgets] = useState({
    connections: false,
    hometowns: false,
    ticker: false,
  });

  /* URL overrides, e.g. ?kuwahara=0.4&grain=0 or ?perf=lite —
     handy for weak GPUs and shareable tunings */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if ([...q.keys()].length === 0) return;
    if (q.get("tune") === "1") setTuneVisible(true);
    setParams((pr) => {
      const next = { ...pr };
      if (q.get("perf") === "lite") {
        next.kuwahara = 0.4;
        next.kuwaKernel = 1.4;
        next.impasto = 0.25;
        next.grain = 0.08;
      }
      const limits = Object.fromEntries(
        PANEL_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i]))
      );
      for (const [k, v] of q.entries()) {
        if (k === "field" && (v === "weather" || v === "cartography" || v === "stars")) {
          next.field = v;
        } else if (k in DEFAULTS && !Number.isNaN(parseFloat(v))) {
          const n = parseFloat(v);
          const lim = limits[k];
          /* clamp to the slider range — raw floats reach shader uniforms */
          (next as Record<string, unknown>)[k] = lim
            ? Math.min(lim.max, Math.max(lim.min, n))
            : n;
        }
      }
      return next;
    });
  }, []);

  const selectRef = useRef<(personId: string) => void>(() => {});
  const selectGroupRef = useRef<(clusterIndex: number) => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const gl = canvas.getContext("webgl", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      setErr("WebGL is not available in this context.");
      return;
    }

    let bubbleProg: WebGLProgram, kuwaProg: WebGLProgram, gradeProg: WebGLProgram, finishProg: WebGLProgram;
    let tensorProg: WebGLProgram, anisoProg: WebGLProgram;
    try {
      bubbleProg = compileProgram(gl, QUAD_VERT, BUBBLE_FRAG);
      kuwaProg = compileProgram(gl, QUAD_VERT, KUWAHARA_FRAG);
      tensorProg = compileProgram(gl, QUAD_VERT, TENSOR_FRAG);
      anisoProg = compileProgram(gl, QUAD_VERT, ANISO_KUWAHARA_FRAG);
      gradeProg = compileProgram(gl, QUAD_VERT, GRADE_FRAG);
      finishProg = compileProgram(gl, QUAD_VERT, FINISH_FRAG);
    } catch (e) {
      console.error("[pepl] shader:", e);
      setErr(String((e as Error).message || e));
      return;
    }

    const UB = uniformMap(gl, bubbleProg, BUBBLE_UNIFORMS);
    const UK = uniformMap(gl, kuwaProg, ["uTex", "uRes", "uKernel"]);
    const UT = uniformMap(gl, tensorProg, ["uTex", "uRes"]);
    const UA = uniformMap(gl, anisoProg, ["uTex", "uTensor", "uRes", "uKernel"]);
    const UG = uniformMap(gl, gradeProg, ["uScene", "uKuwa", "uRes", "uKuwaAmt", "uGradeAmt", "uCenter", "uRadius"]);
    const UF = uniformMap(gl, finishProg, ["uTex", "uRes", "uImpasto"]);

    const buf = bindFullscreenTriangle(gl, [bubbleProg, kuwaProg, tensorProg, anisoProg, gradeProg, finishProg]);

    const sheetTex = makeTexture(gl);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    gl.useProgram(bubbleProg);
    gl.uniform1i(UB.uTex as WebGLUniformLocation, 0);
    gl.uniform1f(UB.uGrain as WebGLUniformLocation, 0.0); // grain moved to the last pass
    gl.useProgram(kuwaProg);
    gl.uniform1i(UK.uTex as WebGLUniformLocation, 0);
    gl.useProgram(tensorProg);
    gl.uniform1i(UT.uTex as WebGLUniformLocation, 0);
    gl.useProgram(anisoProg);
    gl.uniform1i(UA.uTex as WebGLUniformLocation, 0);
    gl.uniform1i(UA.uTensor as WebGLUniformLocation, 1);
    gl.useProgram(gradeProg);
    gl.uniform1i(UG.uScene as WebGLUniformLocation, 0);
    gl.uniform1i(UG.uKuwa as WebGLUniformLocation, 1);
    gl.useProgram(finishProg);
    gl.uniform1i(UF.uTex as WebGLUniformLocation, 0);

    gl.clearColor(0.968, 0.964, 0.957, 1.0);

    /* render targets */
    let rtScene: RenderTarget | null = null;
    let rtK: RenderTarget | null = null;
    let rtB: RenderTarget | null = null;
    let rtT: RenderTarget | null = null; // structure tensor, exportQuality only
    /* 0.5 = live default; 0.25 = perf fallback; 1.0 = exportQuality stills */
    let kuwaScale = 0.5;
    let exportQ = false;

    const recreateTargets = () => {
      destroyTarget(gl, rtScene);
      destroyTarget(gl, rtK);
      destroyTarget(gl, rtB);
      destroyTarget(gl, rtT);
      rtT = null;
      const w = canvas.width, h = canvas.height;
      rtScene = makeTarget(gl, w, h);
      rtB = makeTarget(gl, w, h);
      const ks = exportQ ? 1.0 : kuwaScale;
      rtK = makeTarget(gl, Math.max(2, Math.floor(w * ks)), Math.max(2, Math.floor(h * ks)));
      if (exportQ) rtT = makeTarget(gl, w, h);
    };

    const sheet = new GraphSheet(defaultAdapter, ROOM_EDGES);
    /* who touches whom, over every thread type — the focused person's
       whole web lights up: dots swell and their names surface */
    const neighborsByPerson = new Map<string, Set<string>>();
    for (const e of ROOM_EDGES) {
      let sa = neighborsByPerson.get(e.s);
      if (!sa) neighborsByPerson.set(e.s, (sa = new Set()));
      sa.add(e.t);
      let sb = neighborsByPerson.get(e.t);
      if (!sb) neighborsByPerson.set(e.t, (sb = new Set()));
      sb.add(e.s);
    }
    let boards: BoardState[] = [];
    let choreo = new Choreography(defaultAdapter.groups().length);
    const breatheAt: number[] = [];
    const breatheRng = mulberry32(77);
    let labelAlpha: number[] = [];
    let nameAlpha: number[] = [];
    const t0 = performance.now();

    const resolveFont = () => {
      const css = getComputedStyle(document.documentElement);
      const fam = css.getPropertyValue("--font-jakarta").trim();
      const serif = css.getPropertyValue("--font-hedvig").trim();
      if (fam) sheet.fontFamily = fam;
      if (serif) sheet.serifFamily = `${serif}, Georgia, serif`;
      /* thread hues ride the same runtime-token path as the type — the
         canvas never invents a hex (law f) */
      sheet.edgeHues = {
        school: css.getPropertyValue("--film-blue").trim(),
        company: css.getPropertyValue("--film-gold").trim(),
        seek: css.getPropertyValue("--film-magenta").trim(),
        why: css.getPropertyValue("--film-violet").trim(),
      };
      /* the name-label tints ride the same path: Teri's full spectrum scale,
         read straight off :root (the --film-* aliases above are eight steps of
         this same set). A missing token drops out of the palette rather than
         being replaced — no hex is ever invented here. */
      const spectrum: string[] = [];
      for (let i = 0; i < 8; i++) {
        const v = css.getPropertyValue(`--usp-spectrum-${i}`).trim();
        if (v) spectrum.push(v);
      }
      sheet.labelSpectrum = spectrum;
      sheet.bakeLabelTints(); // no-op until the layout exists; resize bakes it too
    };
    resolveFont();
    document.fonts?.ready?.then(() => {
      resolveFont();
      sheet.bakeNames(); // rebake serif names with the real Hedvig
    });

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);

    /* ---------- bubble body ---------- */
    const ptr = {
      x: 0, y: 0, down: false, grabbed: false, id: -1, ox: 0, oy: 0, downT: 0, dx0: 0, dy0: 0,
      /* camera pan: engaged once a non-bubble press travels past PAN_START */
      panning: false, panCamX: 0, panCamY: 0, panPX: 0, panPY: 0,
      /* the dot this press landed on (-1 none) and the world-space offset from
         the pointer to its centre, so a picked-up dot never jumps */
      dot: -1, dragging: false, dotOX: 0, dotOY: 0,
    };
    const body = { x: 0, y: 0.06, vx: 0, vy: 0, dx: 0, dy: 0, dvx: 0, dvy: 0 };
    let focused: FocusedPerson | null = null;
    let selectedGroup: number | null = null;
    let zoomAnim = paramsRef.current.zoom;
    /* the LIVE lens radius — every hit-test, mask and uniform reads this,
       never params.radius directly, so the pop can animate it as one */
    let lensR = paramsRef.current.radius;
    let radiusCur = lensR;
    let popAt = -1; // >= 0 while the burst animation is running
    let popFromR = 0;
    /* scene camera: world point at view centre + scale, eased each frame */
    const cam = { s: 1, x: 0, y: 0, ts: 1, tx: 0, ty: 0 };

    /* ---------- space conversions ---------- */
    const dims = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      return { w, h, mn: Math.min(w, h) || 1 };
    };
    const toShader = (px: number, py: number) => {
      const { w, h, mn } = dims();
      return { x: (px - w / 2) / mn, y: -(py - h / 2) / mn };
    };
    const toSheet = (sx: number, sy: number) => {
      const { w, h, mn } = dims();
      return { x: sx * mn + w / 2, y: -sy * mn + h / 2 };
    };
    /* scene camera transforms: layout world px ↔ rendered screen px */
    const worldToScreen = (wx: number, wy: number) => {
      const { w, h } = dims();
      return { x: (wx - cam.x) * cam.s + w / 2, y: (wy - cam.y) * cam.s + h / 2 };
    };
    const screenToWorld = (sx: number, sy: number) => {
      const { w, h } = dims();
      return { x: (sx - w / 2) / cam.s + cam.x, y: (sy - h / 2) / cam.s + cam.y };
    };
    /**
     * Home is not 1:1 — it is "the whole room, small enough to sit inside the
     * bubble". The sheet's own extent decides the scale, so the fit holds at any
     * viewport size and for any guest count. Popping the bubble releases it to
     * full size (see `popped`).
     */
    const camHome = () => {
      const { w, h } = dims();
      const L = sheet.layout;
      let s = 1;
      if (L && !poppedRef.current) {
        let ext = 0;
        for (const cl of L.clusters) {
          ext = Math.max(ext, Math.hypot(cl.cx - w / 2, cl.cy - h / 2) + cl.radius);
        }
        // fit the whole room inside the lens, with a little air
        const fitR = unpoppedLensR(paramsRef.current) * Math.min(w, h) * 0.92;
        if (ext > 0) s = Math.max(0.12, Math.min(1, fitR / ext));
      }
      cam.ts = s;
      cam.tx = w / 2;
      cam.ty = h / 2;
    };
    /* mirror the shader's forward sampling map (zoom + rim fisheye):
       hit-testing asks "which sheet point is displayed at p", so apply
       the same q = center + pc/zoom − N.xy·warp·(1−cosI)^1.5·0.55 */
    const unproject = (p: { x: number; y: number }) => {
      const P = paramsRef.current;
      const dx = p.x - body.x, dy = p.y - body.y;
      const d = Math.hypot(dx, dy);
      if (d < lensR) {
        const z = Math.max(zoomAnim, 1);
        const dn = Math.min(d / lensR, 1);
        const cosI = Math.sqrt(Math.max(0, 1 - dn * dn));
        const w = P.warp * Math.pow(1 - cosI, 1.5) * 0.55;
        return {
          x: body.x + dx / z - (dx / lensR) * w,
          y: body.y + dy / z - (dy / lensR) * w,
        };
      }
      return p;
    };
    /* pointer (shader space) → through the lens → through the camera → the
       layout's own world px. Every hit test and the dot drag share it. */
    const pointerWorld = (p: { x: number; y: number }) => {
      const g = unproject(p);
      const s = toSheet(g.x, g.y);
      return screenToWorld(s.x, s.y);
    };
    /* the dot under the pointer, as a layout INDEX (-1 = none) — the index is
       what the drag carries and what the sheet needs to hold it still */
    const dotAt = (p: { x: number; y: number }, tolPx = 9) => {
      const L = sheet.layout;
      if (!L) return -1;
      const wpt = pointerWorld(p);
      let best = -1;
      let bestD = tolPx;
      for (let i = 0; i < L.dots.length; i++) {
        const d = L.dots[i];
        const dist = Math.hypot(d.x - wpt.x, d.y - wpt.y);
        if (dist < bestD) {
          bestD = dist;
          best = i;
        }
      }
      return best;
    };
    /* pointer → world → serif group-name hit. Only names that are
       actually visible are clickable — a faded-out name over an awake
       board must not swallow taps or show a phantom cursor. */
    const groupNameAt = (p: { x: number; y: number }) => {
      const wpt = pointerWorld(p);
      const rects = sheet.nameRects();
      for (let ci = 0; ci < rects.length; ci++) {
        /* only visible inscriptions are clickable */
        if (choreo.phases[ci] === "focused" || nameAlpha[ci] < 0.2) continue;
        const r = rects[ci];
        if (
          wpt.x >= r.x - 6 && wpt.x <= r.x + r.w + 6 &&
          wpt.y >= r.y - 6 && wpt.y <= r.y + r.h + 6
        ) {
          return ci;
        }
      }
      return null;
    };

    const rebuildBoards = () => {
      const L = sheet.layout!;
      boards = L.clusters.map((cl) => {
        const b = new BoardState(cl.board.cols);
        b.setText(""); // at rest the board is blank — the serif name speaks
        return b;
      });
      choreo = new Choreography(L.clusters.length);
      labelAlpha = L.clusters.map(() => 0);
      nameAlpha = L.clusters.map(() => 0); // fades in from blank
      breatheAt.length = 0;
      /* offsets from now, not from mount — a rebuild late in the
         session must not fire every board's breathe at once */
      const tNow = (performance.now() - t0) / 1000;
      L.clusters.forEach(() => breatheAt.push(tNow + 8 + breatheRng() * 16));
      focused = null;
      selectedGroup = null;
      /* camera home, snapped — the layout underneath just changed */
      camHome();
      cam.s = cam.ts;
      cam.x = cam.tx;
      cam.y = cam.ty;
    };

    const resize = () => {
      const { w, h } = dims();
      const pw = Math.max(1, Math.floor(w * dpr));
      const ph = Math.max(1, Math.floor(h * dpr));
      const sizeChanged = canvas.width !== pw || canvas.height !== ph;
      if (sizeChanged) {
        canvas.width = pw;
        canvas.height = ph;
      }
      /* Recreate on a size change OR whenever a target is missing.
       *
       * Upstream only recreated on a size change, which silently dies on a
       * REMOUNT: the effect's cleanup destroys the targets and the new run
       * starts with rt* = null, but the canvas ELEMENT survives with its
       * width/height already set — so the size check is false, the targets are
       * never built, and every frame returns at the `!rtScene` guard. The scene
       * then renders one stale frame and freezes, with no error anywhere.
       * React's double-invoked effects and Fast Refresh both hit this. */
      if (sizeChanged || !rtScene || !rtK || !rtB) recreateTargets();
      if (sheet.resize(w, h, dpr)) rebuildBoards();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    /* Pause the loop only when the TAB is hidden.
     *
     * Upstream gated this on an IntersectionObserver over the canvas. Here the
     * canvas is a full-bleed child of a route shell that lays out after the
     * observer is attached, so the first callback lands while the box is still
     * empty, latches visible=false, and never re-fires — the loop then schedules
     * forever and returns before drawing, leaving exactly one frame painted and
     * every interaction dead. document.hidden expresses the real intent (don't
     * burn GPU in a background tab) and cannot latch. */
    let visible = typeof document === "undefined" ? true : !document.hidden;
    const onVis = () => {
      visible = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVis);

    /* ---------- selection ---------- */
    const flashFade = () => {
      const f = fadeRef.current;
      if (!f) return;
      f.style.transition = "none";
      f.style.opacity = "1";
      requestAnimationFrame(() => {
        f.style.transition = "opacity 200ms ease-out";
        f.style.opacity = "0";
      });
    };

    /* one-way for the session: the burst runs, then the small toy returns */
    const popBubble = () => {
      if (poppedRef.current) return;
      poppedRef.current = true;
      setPopped(true);
      popAt = performance.now();
      popFromR = lensR;
    };

    const select = (personId: string) => {
      const L = sheet.layout;
      if (!L) return;
      const d = L.dots.find((x) => x.person.id === personId);
      if (!d) return;
      popBubble(); // the camera is about to enter the room — the room can't stay inside the lens
      selectedGroup = null;
      focused = { id: personId, name: d.person.name, clusterIndex: d.clusterIndex };
      /* the camera does the travel: the person lands left-of-centre so
         the stamps and echo have room — and always OUTSIDE the resident
         bubble's footprint, or the dot ends up in the lens dead zone */
      const { w, h, mn } = dims();
      const s = SCENE_ZOOM_PERSON;
      let ox = -0.17 * w, oy = -0.07 * h; // dot's screen offset from centre
      /* clear of the bubble WHERE IT ACTUALLY IS — the popped toy is free-
         floating, so its current position is the only truthful footprint */
      const bx = body.x * mn, by = -body.y * mn;
      const dPx = Math.hypot(ox - bx, oy - by);
      const clear = lensR * mn * 1.15;
      if (dPx < clear) {
        const k = clear / Math.max(dPx, 1e-3);
        ox = bx + (ox - bx) * k;
        oy = by + (oy - by) * k;
      }
      cam.ts = s;
      cam.tx = d.x - ox / s;
      cam.ty = d.y - oy / s;
      if (reduced) {
        cam.s = cam.ts; cam.x = cam.tx; cam.y = cam.ty;
        flashFade();
      }
    };
    selectRef.current = select;

    /* choose a whole group: zoom in until its serif inscription reads
       large; the board wakes into the field underneath */
    const selectGroup = (ci: number) => {
      const L = sheet.layout;
      if (!L || !L.clusters[ci]) return;
      popBubble();
      const cl = L.clusters[ci];
      const { w, h, mn } = dims();
      focused = null;
      selectedGroup = ci;
      cam.ts = Math.min(2.6, Math.max(1.9, (0.4 * mn) / cl.radius));
      /* the inscription lands clear of the resident bubble — measured
         as the title's full screen rect, not just its centre point */
      const nx = cl.board.x + cl.board.w / 2;
      const ny = cl.board.y + cl.board.h / 2;
      let ox = -0.16 * w, oy = 0.1 * h;
      const bx = body.x * mn, by = -body.y * mn;
      const clear = lensR * mn * 1.15;
      const nr = sheet.nameRects()[ci];
      const hw2 = nr ? (nr.w / 2) * cam.ts : 0;
      const hh2 = nr ? (nr.h / 2) * cam.ts : 0;
      const dxn = Math.max(0, Math.abs(ox - bx) - hw2);
      const dyn = Math.max(0, Math.abs(oy - by) - hh2);
      if (Math.hypot(dxn, dyn) < clear) {
        /* push the title straight down until its top edge clears */
        oy = by + hh2 + Math.sqrt(Math.max(clear * clear - dxn * dxn, 0)) + 10;
      }
      cam.tx = nx - ox / cam.ts;
      cam.ty = ny - oy / cam.ts;
      if (reduced) {
        cam.s = cam.ts; cam.x = cam.tx; cam.y = cam.ty;
        flashFade();
      }
    };
    selectGroupRef.current = selectGroup;

    const clearFocus = () => {
      if (reduced && (focused || selectedGroup != null)) flashFade();
      focused = null;
      selectedGroup = null;
      camHome();
      if (reduced) {
        cam.s = cam.ts; cam.x = cam.tx; cam.y = cam.ty;
      }
    };

    /* ---------- pointer ---------- */
    const toLocal = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      const mn = Math.min(r.width, r.height) || 1;
      return {
        x: (e.clientX - r.left - r.width / 2) / mn,
        y: -(e.clientY - r.top - r.height / 2) / mn,
      };
    };

    const hover = { id: null as string | null, group: null as number | null };

    /* hover itself is re-derived every frame (the camera and bubble
       move under a stationary pointer); onMove just records position */
    const onMove = (e: PointerEvent) => {
      if (ptr.down && e.pointerId !== ptr.id) return; // one pointer drives
      const q = toLocal(e);
      ptr.x = q.x;
      ptr.y = q.y;
      ptrIn = true;

      /* a press that landed on a dot CARRIES it: past the click slop the dot
         goes 1:1 under the pointer and stays wherever it is let go. Its
         cluster keeps it — tint, threads and the group's guideline all follow
         it out. This runs before the pan so a carried dot never drags the
         camera as well (the slop is under PAN_START, so the return always
         wins the race). */
      const carried = ptr.down && ptr.dot >= 0 && !ptr.grabbed ? sheet.layout : null;
      if (carried) {
        const d = carried.dots[ptr.dot];
        if (!ptr.dragging && Math.hypot(q.x - ptr.dx0, q.y - ptr.dy0) > CLICK_SLOP) {
          ptr.dragging = true;
          wrap.style.cursor = "grabbing";
          /* hover IS the "this one is in hand" channel: it swells the dot and
             surfaces its name, including labels the placement pass culled */
          hover.id = d.person.id;
          hover.group = null;
          try {
            wrap.setPointerCapture(e.pointerId);
          } catch {}
        }
        if (ptr.dragging) {
          const wpt = pointerWorld(q);
          d.x = wpt.x + ptr.dotOX;
          d.y = wpt.y + ptr.dotOY;
          return;
        }
      }

      /* click-drag on the sheet PANS the camera — 1:1 under the pointer,
         so both the target and the eased position snap while it lasts */
      if (ptr.down && !ptr.grabbed) {
        if (!ptr.panning && Math.hypot(q.x - ptr.dx0, q.y - ptr.dy0) > PAN_START) {
          ptr.panning = true;
          ptr.panCamX = cam.x;
          ptr.panCamY = cam.y;
          ptr.panPX = q.x;
          ptr.panPY = q.y;
          wrap.style.cursor = "grabbing";
        }
        if (ptr.panning) {
          const { mn } = dims();
          cam.tx = ptr.panCamX - ((q.x - ptr.panPX) * mn) / cam.s;
          cam.ty = ptr.panCamY + ((q.y - ptr.panPY) * mn) / cam.s;
          cam.x = cam.tx;
          cam.y = cam.ty;
        }
      }
    };

    const onLeave = () => {
      ptrIn = false;
      if (ptr.dragging) return; // a carried dot follows the pointer off-canvas
      hover.id = null;
      hover.group = null;
      if (!ptr.grabbed) wrap.style.cursor = "default";
    };

    const onDown = (e: PointerEvent) => {
      if (ptr.down) return; // a second finger never steals the gesture
      const q = toLocal(e);
      ptr.id = e.pointerId;
      ptr.x = q.x; ptr.y = q.y; ptr.down = true;
      ptr.downT = performance.now();
      ptr.dx0 = q.x; ptr.dy0 = q.y;
      ptr.dot = -1;
      if (Math.hypot(q.x - body.x, q.y - body.y) < lensR * 1.15) {
        ptr.grabbed = true;
        ptr.ox = body.x - q.x;
        ptr.oy = body.y - q.y;
        wrap.style.cursor = "grabbing";
        try {
          wrap.setPointerCapture(e.pointerId);
        } catch {}
        return;
      }
      /* remember what the press landed on; whether it is a click or a carry
         is only decided once the pointer moves (see onMove) */
      const di = dotAt(q);
      const dot = di >= 0 ? sheet.layout?.dots[di] : null;
      if (dot) {
        ptr.dot = di;
        const wpt = pointerWorld(q);
        ptr.dotOX = dot.x - wpt.x;
        ptr.dotOY = dot.y - wpt.y;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (ptr.down && e.pointerId !== ptr.id) return;
      const wasDown = ptr.down;
      const wasGrabbed = ptr.grabbed;
      const wasPanning = ptr.panning;
      const wasCarrying = ptr.dragging;
      ptr.down = false;
      ptr.grabbed = false;
      ptr.panning = false;
      ptr.dragging = false;
      ptr.dot = -1;
      ptr.id = -1;
      if (wasPanning || wasCarrying) {
        /* neither a pan nor a carry is a click. A dropped dot stays exactly
           where it was let go — the room's positions are live, and its group
           has already flowed out around it. */
        wrap.style.cursor = "default";
        return;
      }
      /* releases that began on UI chrome (search, panel, pills) never
         reach onDown, so they must not select or clear anything */
      if (!wasDown) return;
      wrap.style.cursor = "default";
      /* an aborted gesture (system took the touch) must not select */
      if (e.type === "pointercancel") return;

      const q = "clientX" in e ? toLocal(e) : { x: ptr.x, y: ptr.y };
      const elapsed = performance.now() - ptr.downT;
      const moved = Math.hypot(q.x - ptr.dx0, q.y - ptr.dy0);

      /* the FIRST click pops the bubble — ANYWHERE on the scene, and with a
         forgiving press (a few px of wobble must not read as a drag): the
         whole room lives inside the lens pre-pop, so there is nothing else a
         first click could mean. The room releases to full size and the
         bubble returns as a small toy. A deliberate drag still moves it. */
      if (!poppedRef.current && elapsed < 450 && moved < PAN_START) {
        popBubble();
        camHome(); // re-fit: popped home is the full-size room
        return;
      }

      if (elapsed < 300 && moved < CLICK_SLOP) {
        const di = dotAt(q);
        const dot = di >= 0 ? sheet.layout?.dots[di] : null;
        if (dot) {
          select(dot.person.id);
          return;
        }
        const gi = groupNameAt(q);
        if (gi != null) selectGroup(gi);
        else clearFocus();
        return;
      }

      /* a drag-release just lets the bubble go — it springs back home
         on its own; selection is clicks, titles, and search only */
      void wasGrabbed;
    };

    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerdown", onDown);
    wrap.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    /* Wheel is the SCENE's zoom, never the browser's. A trackpad pinch
       arrives as ctrl+wheel, and without preventDefault the browser zooms
       the whole site around the canvas. React's synthetic onWheel attaches
       passively, so this must be a native non-passive listener — on the
       route shell, so a pinch over the ticker or map is captured too.
       Anchored to the cursor: the world point under it stays put. */
    const rootEl = wrap.parentElement ?? wrap;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const anchor = screenToWorld(sx, sy);
      const k = e.ctrlKey ? 0.008 : 0.0016; // pinch deltas are small + fast
      const ns = Math.min(3.2, Math.max(0.1, cam.ts * Math.exp(-e.deltaY * k)));
      cam.ts = ns;
      cam.tx = anchor.x - (sx - r.width / 2) / ns;
      cam.ty = anchor.y - (sy - r.height / 2) / ns;
      if (reduced) {
        cam.s = cam.ts; cam.x = cam.tx; cam.y = cam.ty;
      }
    };
    rootEl.addEventListener("wheel", onWheel, { passive: false });

    /* ---------- loop ---------- */
    let raf = 0;
    let last = t0;
    let lx = 0, ly = 0;
    let burstShown = false;
    let burstId = "";
    let ptrIn = false;
    let emaMs = 16;
    let lastGateCheck = 0;
    let kernelCap = 3;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const frameMs = now - last;
      const dt = Math.min(0.032, Math.max(0.0005, frameMs / 1000));
      last = now;
      if (!visible) return;

      /* perf gate: under ~45fps, drop Kuwahara to quarter res before
         degrading anything else; if that isn't enough, cap the kernel */
      emaMs = emaMs + (Math.min(frameMs, 100) - emaMs) * 0.04;
      if (now - lastGateCheck > 1500) {
        lastGateCheck = now;
        if (!exportQ && emaMs > 22) {
          if (kuwaScale > 0.3) {
            kuwaScale = 0.25;
            recreateTargets();
          } else if (kernelCap > 1.6) {
            kernelCap = 1.6;
          }
        }
      }
      if (paramsRef.current.exportQuality !== exportQ) {
        exportQ = paramsRef.current.exportQuality;
        recreateTargets();
      }

      const t = reduced ? 12.0 : (now - t0) / 1000;
      const P = paramsRef.current;
      const b = body;
      const L = sheet.layout;
      if (!L || !rtScene || !rtK || !rtB) return;
      const { w, h, mn } = dims();

      if (!Number.isFinite(b.x + b.y + b.vx + b.vy + b.dx + b.dy + b.dvx + b.dvy)) {
        b.x = 0; b.y = 0.06;
        b.vx = b.vy = b.dx = b.dy = b.dvx = b.dvy = 0;
      }

      /* --- lens radius: pop burst, then ease to the state's size --- */
      /* bubbleScale is one handle over both states (Addendum 5), but only the
         popped toy has room to grow: the unpopped lens is the room's container
         and is already at its ceiling, so that product is clamped. Everything
         downstream — the clarity lens, the grab radius, the pop burst — reads
         lensR, so this one multiply carries the whole bubble. */
      const targetR = poppedRef.current
        ? POPPED_RADIUS * P.bubbleScale
        : unpoppedLensR(P);
      if (reduced) {
        popAt = -1;
        radiusCur = targetR;
        lensR = targetR;
      } else if (popAt >= 0) {
        const el = now - popAt;
        if (el < 160) {
          lensR = popFromR * (1 - el / 160); // the burst
        } else if (el < 460) {
          lensR = 0; // a beat of absence before it comes back
        } else {
          popAt = -1;
          radiusCur = 0; // regrow from nothing
        }
      }
      if (popAt < 0 && !reduced) {
        radiusCur += (targetR - radiusCur) * (1 - Math.exp(-dt * 3.2));
        lensR = radiusCur;
      }

      /* --- scene camera easing (snapped when reduced) --- */
      if (reduced) {
        cam.s = cam.ts; cam.x = cam.tx; cam.y = cam.ty;
      } else {
        const ck = 1 - Math.exp(-dt * 2.4);
        cam.s += (cam.ts - cam.s) * ck;
        cam.x += (cam.tx - cam.x) * ck;
        cam.y += (cam.ty - cam.y) * ck;
      }

      /* --- hover, re-derived per frame: the world moves under a
             stationary pointer while the camera eases and the bubble
             wanders --- */
      if (ptrIn && !ptr.grabbed && !ptr.panning && !ptr.dragging) {
        const q = { x: ptr.x, y: ptr.y };
        const hd = dotAt(q);
        hover.id = hd >= 0 ? L.dots[hd].person.id : null;
        hover.group = hd >= 0 ? null : groupNameAt(q);
        const overBubble =
          Math.hypot(q.x - body.x, q.y - body.y) < lensR * 1.15;
        wrap.style.cursor =
          hd >= 0 || hover.group != null ? "pointer" : overBubble ? "grab" : "default";
      }

      /* --- forces --- */
      let ax = 0, ay = 0;
      const halfW = w / mn / 2;
      const halfH = h / mn / 2;

      if (ptr.grabbed) {
        const k = 150 * P.grip;
        const c = 2 * Math.sqrt(k) * 1.15;
        ax += (ptr.x + ptr.ox - b.x) * k - b.vx * c;
        ay += (ptr.y + ptr.oy - b.y) * k - b.vy * c;
      } else if (!poppedRef.current) {
        /* UNPOPPED, the bubble is the room's container: a spring holds it
           centre-stage with the whole party inside. */
        ax += (0 - b.x) * 6.0;
        ay += (0.02 - b.y) * 6.0;
        if (!reduced) {
          ay -= P.gravity;
          ax += (Math.sin(t * 0.31) + 0.6 * Math.sin(t * 0.17 + 2.1)) * 0.038 * P.wander;
          ay += (Math.sin(t * 0.23 + 1.3) + 0.5 * Math.sin(t * 0.41 + 4.2)) * 0.032 * P.wander;
        }
      } else if (!reduced) {
        /* POPPED, it is a free toy: no home spring — drag it into a corner
           and it STAYS there (viscosity below brings it to rest; the walls
           still bounce). Only gravity/wander act, both 0 by default. */
        ay -= P.gravity;
        ax += (Math.sin(t * 0.31) + 0.6 * Math.sin(t * 0.17 + 2.1)) * 0.038 * P.wander;
        ay += (Math.sin(t * 0.23 + 1.3) + 0.5 * Math.sin(t * 0.41 + 4.2)) * 0.032 * P.wander;
      }

      ax -= b.vx * P.drag;
      ay -= b.vy * P.drag;

      b.vx += ax * dt; b.vy += ay * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;

      const R = Math.max(lensR, 0.02); // popped-out zero must not wedge it in a wall
      const KICK = 1.2;
      if (b.x < -halfW + R) { b.x = -halfW + R; const s = Math.abs(b.vx); b.vx = s * P.bounce; b.dvy += s * KICK; }
      if (b.x > halfW - R) { b.x = halfW - R; const s = Math.abs(b.vx); b.vx = -s * P.bounce; b.dvy += s * KICK; }
      if (b.y < -halfH + R) { b.y = -halfH + R; const s = Math.abs(b.vy); b.vy = s * P.bounce; b.dvx += s * KICK; }
      if (b.y > halfH - R) { b.y = halfH - R; const s = Math.abs(b.vy); b.vy = -s * P.bounce; b.dvx += s * KICK; }

      /* --- squish spring --- */
      const wfreq = 2 * Math.PI * P.jiggle;
      const zeta = P.settle;
      const sp = Math.hypot(b.vx, b.vy);
      let tx = 0, ty = 0;
      if (sp > 1e-5 && P.squish !== 0) {
        const mag = MAX_DEFORM * (1 - Math.exp(-sp * Math.abs(P.squish)));
        const ux = b.vx / sp, uy = b.vy / sp;
        if (P.squish >= 0) { tx = -uy * mag; ty = ux * mag; }
        else { tx = ux * mag; ty = uy * mag; }
      }
      b.dvx += (-(b.dx - tx) * wfreq * wfreq - b.dvx * 2 * zeta * wfreq) * dt;
      b.dvy += (-(b.dy - ty) * wfreq * wfreq - b.dvy * 2 * zeta * wfreq) * dt;
      b.dx += b.dvx * dt;
      b.dy += b.dvy * dt;
      const dvm = Math.hypot(b.dvx, b.dvy);
      if (dvm > 8) { b.dvx *= 8 / dvm; b.dvy *= 8 / dvm; }

      void sp;

      /* --- lens zoom: constant toy magnification, eased for the slider --- */
      if (reduced) zoomAnim = P.zoom;
      else zoomAnim += (P.zoom - zoomAnim) * (1 - Math.exp(-dt * 3.2));

      /* --- active cluster: the chosen person's, or the chosen group --- */
      const active: number | null = focused ? focused.clusterIndex : selectedGroup;

      /* --- choreography + boards --- */
      choreo.update(now, active, focused, boards, L, {
        morphDur: P.morphDur,
        morphHold: P.morphHold,
        hopDur: P.hopDur,
        hopHold: P.hopHold,
        field: P.field,
      }, reduced);

      const boardsDirty = boards.map((bd, ci) => {
        if (
          !reduced &&
          choreo.phases[ci] === "rest" &&
          !bd.isMorphing &&
          t > breatheAt[ci]
        ) {
          breatheAt[ci] = t + 16 + breatheRng() * 12;
          /* resting breathe: the blank board flashes weather and settles */
          bd.morphToText("", now, { duration: 2600, fieldHold: 1100 }, reduced);
        }
        bd.fieldName = bd.isMorphing ? bd.fieldName : P.field;
        /* hover bloom: the group title's glyphs surface lightly and
           blobbily while the pointer rests on the inscription */
        const gainTarget =
          hover.group === ci && choreo.phases[ci] === "rest" && !bd.isMorphing ? 0.8 : 0;
        bd.hoverGain += (gainTarget - bd.hoverGain) * (reduced ? 1 : 1 - Math.exp(-dt * 6));
        return bd.update(now, t, reduced);
      });

      /* --- label + serif-name fades, dot emphasis --- */
      const easeL = reduced ? 1 : 1 - Math.exp(-dt * 5);
      labelAlpha = labelAlpha.map((v, ci) => v + (choreo.labelTarget(ci) - v) * easeL);
      const easeN = reduced ? 1 : 1 - Math.exp(-dt * 2.6);
      nameAlpha = nameAlpha.map((v, ci) => {
        /* the inscription stays up while its group is framed — you
           zoom in *until the group text is large*; it only yields
           when a person inside is focused */
        const target = choreo.phases[ci] === "focused" ? 0 : 1;
        return v + (target - v) * easeN;
      });
      const bubbleSheet = toSheet(b.x, b.y);
      const lensPx = lensR * mn;
      /* --- the clarity lens: punch the bubble out of the veil (law (d) at
             VEIL_DIM). CSS px throughout — dims() is clientWidth/Height and
             the veil is inset:0 in the same box, so this is the very space
             the stamp anchor writes in; no dpr anywhere. --- */
      if (veilLiveRef.current && veilRef.current) {
        const vs = veilRef.current.style;
        vs.setProperty("--lens-x", `${bubbleSheet.x.toFixed(1)}px`);
        vs.setProperty("--lens-y", `${bubbleSheet.y.toFixed(1)}px`);
        vs.setProperty("--lens-r", `${Math.max(0, lensPx).toFixed(1)}px`);
      }
      /* the focused dot anchors the label bloom; the bubble anchors
         only the genuine lens-proximity effects */
      const focusDot = focused
        ? L.dots.find((x) => x.person.id === focused!.id) ?? null
        : null;
      const focusAnchor = focusDot
        ? worldToScreen(focusDot.x, focusDot.y)
        : bubbleSheet;
      /* distances measured on screen — the camera moves the world */
      const dotScreenDist = (i: number) => {
        const d = L.dots[i];
        const s = worldToScreen(d.x, d.y);
        return Math.hypot(s.x - bubbleSheet.x, s.y - bubbleSheet.y);
      };
      const nbrs = focused ? neighborsByPerson.get(focused.id) ?? null : null;
      const dotEmphasis = (i: number) => {
        const d = L.dots[i];
        if (focused && d.person.id === focused.id) return 1.45;
        if (nbrs?.has(d.person.id)) return 1.28;
        return dotScreenDist(i) < lensPx ? 1.22 : 1;
      };
      /* every dot carries its name: a quiet rest label everywhere,
         brighter under the lens, brightest around the focus */
      const labelFor = (i: number) => {
        const d = L.dots[i];
        /* labels culled by the placement pass only surface for their
           own hover/focus moment */
        if (!d.labelVis) {
          const mine =
            hover.id === d.person.id ||
            (focused && focused.id === d.person.id) ||
            (nbrs?.has(d.person.id) ?? false);
          return mine ? 1 : 0;
        }
        if (nbrs?.has(d.person.id)) return 0.92;
        const rest = 0.38;
        const underLens = dotScreenDist(i) < lensPx ? 0.62 : 0;
        const ca = labelAlpha[d.clusterIndex];
        const s2 = worldToScreen(d.x, d.y);
        const fd = Math.hypot(s2.x - focusAnchor.x, s2.y - focusAnchor.y);
        const fall =
          1 - Math.min(1, Math.max(0, (fd - lensPx * 0.55) / (lensPx * 0.45)));
        return Math.max(rest, underLens, ca * fall);
      };

      /* --- stamp burst, anchored to the focused dot. (The big serif name
             echo that used to ride along is gone by decree — the stamps
             already carry the name.) Identity is the id — two guests can
             share a name. --- */
      const wantBurst = !!focused;
      if (wantBurst !== burstShown || (focused && focused.id !== burstId)) {
        burstShown = wantBurst;
        burstId = focused ? focused.id : burstId;
        if (focused) {
          const prev = stampsLiveRef.current;
          if (prev && prev.on && prev.personKey !== focused.id && stampsRef.current) {
            /* person-to-person refocus: keep the outgoing burst
               mounted in place so it peels instead of jump-cutting */
            const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)(?: scale\((-?[\d.]+)\))?/.exec(
              stampsRef.current.style.transform || ""
            );
            setPeeling({
              ...prev,
              at: m
                ? { x: parseFloat(m[1]), y: parseFloat(m[2]), k: m[3] ? parseFloat(m[3]) : 1 }
                : { x: 0, y: 0, k: 1 },
            });
            if (peelTimerRef.current) clearTimeout(peelTimerRef.current);
            peelTimerRef.current = setTimeout(() => setPeeling(null), 700);
          }
          const next = {
            personKey: focused.id,
            name: focused.name,
            details: GUEST_DETAILS[focused.id] ?? {},
            on: true,
          };
          stampsLiveRef.current = next;
          setStamps(next);
        } else {
          stampsLiveRef.current = stampsLiveRef.current
            ? { ...stampsLiveRef.current, on: false }
            : null;
          setStamps((s) => (s && s.on ? { ...s, on: false } : s));
        }
      }
      /* stamps draw OVER the bubble now — the old disc mask that tucked
         them behind the lens hid half a burst whenever the toy drifted
         near the focused dot */

      if (focusDot) {
        const ds = worldToScreen(focusDot.x, focusDot.y);
        if (stampsRef.current) {
          /* scale the burst down on small viewports; bounds derived
             from the scaled extents so the clamps can never invert */
          /* extents mirror Stamps.tsx SLOTS (tightened 2026-07-25) */
          /* cardScale (Addendum 5) raises the INTRINSIC ceiling — the 1 that
             used to cap a roomy viewport — and is deliberately not a factor on
             the result: the two viewport-fit terms must keep winning, both so
             a phone still gets a burst that fits and so k <= (w-32)/444 holds,
             which is exactly what stops the bounds below from inverting. */
          const k = Math.min(P.cardScale, (w - 32) / 444, (h - 62) / 240);
          const ax2 = Math.min(Math.max(ds.x, 218 * k + 14), w - 226 * k - 18);
          const ay2 = Math.min(Math.max(ds.y, 158 * k + 18), h - 44);
          stampsRef.current.style.transform = `translate(${ax2.toFixed(1)}px, ${ay2.toFixed(1)}px) scale(${k.toFixed(3)})`;
        }
      }

      /* --- draw the sheet, upload as texture --- */
      sheet.draw({
        t,
        dt,
        reduced,
        cam: { s: cam.s, x: cam.x, y: cam.y },
        hoveredId: hover.id,
        focusedId: focused ? focused.id : null,
        boards,
        boardsDirty,
        nameAlpha,
        labelFor,
        dotEmphasis,
        dragIndex: ptr.dragging ? ptr.dot : null,
        edgeOn: edgeOnRef.current,
      });

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sheetTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sheet.canvas);

      lx += (ptr.x - lx) * 0.05;
      ly += (ptr.y - ly) * 0.05;

      /* ---- pass 1: bubble lens → rtScene ---- */
      gl.bindFramebuffer(gl.FRAMEBUFFER, rtScene.fbo);
      gl.viewport(0, 0, rtScene.w, rtScene.h);
      gl.useProgram(bubbleProg);
      const ub = UB as Record<string, WebGLUniformLocation>;
      gl.uniform2f(ub.uRes, rtScene.w, rtScene.h);
      gl.uniform1f(ub.uTime, t);
      gl.uniform2f(ub.uMouse, lx * 2, ly * 2);
      gl.uniform2f(ub.uCenter, b.x, b.y);
      gl.uniform2f(ub.uDeform, b.dx, b.dy);
      gl.uniform2f(ub.uVel, b.vx, b.vy);
      gl.uniform1f(ub.uThick, P.thick);
      gl.uniform1f(ub.uDrain, P.drain);
      gl.uniform1f(ub.uWobble, P.wobble);
      gl.uniform1f(ub.uSurface, P.surface);
      gl.uniform1f(ub.uFlow, reduced ? 0 : P.flow);
      gl.uniform1f(ub.uTurb, P.turb);
      gl.uniform1f(ub.uChroma, P.chroma);
      gl.uniform1f(ub.uEdge, P.edge);
      gl.uniform1f(ub.uZoom, zoomAnim);
      gl.uniform1f(ub.uWarp, P.warp);
      gl.uniform1f(ub.uRadius, lensR);
      gl.uniform1f(ub.uBack, P.back);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      /* ---- pass 2: Kuwahara ----
         live: generalized 8-sector at reduced res.
         exportQuality: structure tensor → anisotropic oriented kernel
         at full res (stills only). */
      if (exportQ && rtT) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, rtT.fbo);
        gl.viewport(0, 0, rtT.w, rtT.h);
        gl.useProgram(tensorProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, rtScene.tex);
        gl.uniform2f(UT.uRes as WebGLUniformLocation, rtT.w, rtT.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, rtK.fbo);
        gl.viewport(0, 0, rtK.w, rtK.h);
        gl.useProgram(anisoProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, rtScene.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, rtT.tex);
        gl.uniform2f(UA.uRes as WebGLUniformLocation, rtK.w, rtK.h);
        gl.uniform1f(UA.uKernel as WebGLUniformLocation, P.kuwaKernel * 2);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, rtK.fbo);
        gl.viewport(0, 0, rtK.w, rtK.h);
        gl.useProgram(kuwaProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, rtScene.tex);
        gl.uniform2f(UK.uRes as WebGLUniformLocation, rtK.w, rtK.h);
        gl.uniform1f(UK.uKernel as WebGLUniformLocation, Math.min(P.kuwaKernel, kernelCap));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      /* ---- pass 3: composite + grade → rtB ---- */
      gl.bindFramebuffer(gl.FRAMEBUFFER, rtB.fbo);
      gl.viewport(0, 0, rtB.w, rtB.h);
      gl.useProgram(gradeProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rtScene.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, rtK.tex);
      gl.uniform2f(UG.uRes as WebGLUniformLocation, rtB.w, rtB.h);
      gl.uniform1f(UG.uKuwaAmt as WebGLUniformLocation, P.kuwahara);
      gl.uniform1f(UG.uGradeAmt as WebGLUniformLocation, P.grade);
      gl.uniform2f(UG.uCenter as WebGLUniformLocation, b.x, b.y);
      gl.uniform1f(UG.uRadius as WebGLUniformLocation, lensR);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      /* ---- pass 4: impasto → screen (grain rides the DOM veil) ---- */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(finishProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rtB.tex);
      gl.uniform2f(UF.uRes as WebGLUniformLocation, canvas.width, canvas.height);
      gl.uniform1f(UF.uImpasto as WebGLUniformLocation, P.impasto);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      rootEl.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerdown", onDown);
      wrap.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      destroyTarget(gl, rtScene);
      destroyTarget(gl, rtK);
      destroyTarget(gl, rtB);
      destroyTarget(gl, rtT);
      gl.deleteTexture(sheetTex);
      [bubbleProg, kuwaProg, tensorProg, anisoProg, gradeProg, finishProg].forEach((p) =>
        gl.deleteProgram(p)
      );
      gl.deleteBuffer(buf);
    };
  }, []);

  const ui: React.CSSProperties = {
    fontFamily: "var(--font-jakarta), system-ui, sans-serif",
    fontSize: 10,
    letterSpacing: "0.08em",
    textTransform: "lowercase",
  };
  const shadow =
    "inset 0 0 0 1px rgba(255,255,255,0.55), 0 0 0 1px rgba(38,36,44,0.045)";
  /* active surfaces pick up the film-blue token; hovers warm with gold */
  const pill = (on: boolean): React.CSSProperties => ({
    ...ui,
    padding: "8px 13px",
    border: "none",
    borderRadius: 999,
    background: on ? "rgba(145,180,249,0.22)" : "rgba(255,253,251,0.72)",
    backdropFilter: "blur(8px)",
    boxShadow: shadow,
    color: on ? "rgba(26,25,24,0.72)" : "rgba(26,25,24,0.52)",
    cursor: "pointer",
  });
  /* the ticker docks the bottom of the room, so everything bottom-anchored
     rides its height + 28 of clearance when it is up and drops to the 20px
     margin when it is not; the legend clears the pill row below it */
  const floor = widgets.ticker ? TICKER_HEIGHT + 28 : 20;
  /* what "clears the pill row" costs, spelled out: a `pill()` button is 8px of
     padding above and below the ~15.5px line box of its 10px type — ~31.5px
     measured — and that row's `gap: 8` runs horizontally BETWEEN pills, so it
     adds nothing to this stack. 44 = the row plus ~12px of air; re-derive it if
     the pill's padding or font size moves. */
  const PILL_ROW_CLEARANCE = 44;
  const legendBottom = floor + PILL_ROW_CLEARANCE;
  /* slider readouts update live — format to the step's precision and
     keep the digits tabular so nothing jitters */
  const fmt = (v: number, step: number) =>
    step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);

  /* ---- relationships widget: rows from the fetched person record ---- */
  const relEdges = profile?.edges ?? [];
  /* their own answer to "who are you looking for?" — the response the seek
     matching ran against. Verbatim or nothing: a blank answer means the
     framing line is simply absent, never a placeholder. */
  const seeking = profile?.answers?.seeking?.trim();
  const sectionOf = (e: NonNullable<PersonRecord["edges"]>[number]) =>
    REL_SECTIONS.find((s) => s.match(e))?.key ?? "other";
  const personName = (id: string) =>
    defaultAdapter.people().find((p) => p.id === id)?.name ??
    id.replace(/-[0-9a-f]{4}$/, "").replace(/-/g, " ");

  /* ---- search: people + groups, flown to on pick ---- */
  type SearchResult =
    | { kind: "person"; id: string; label: string; sub: string }
    | { kind: "group"; gi: number; label: string; sub: string };
  const qn = query.trim().toLowerCase();
  const searchResults: SearchResult[] = qn
    ? [
        ...defaultAdapter
          .groups()
          .map((g, gi) => ({ kind: "group" as const, gi, label: g.name, sub: "group" }))
          .filter((r) => r.label.toLowerCase().includes(qn)),
        ...defaultAdapter
          .people()
          .map((p) => ({
            kind: "person" as const,
            id: p.id,
            label: p.name,
            sub:
              defaultAdapter.groups().find((g) => g.id === p.groupId)?.name.toLowerCase() ?? "",
          }))
          .filter((r) => r.label.toLowerCase().includes(qn)),
      ].slice(0, 10)
    : [];
  const searchSel = Math.max(0, Math.min(searchIdx, searchResults.length - 1));
  const pickResult = (r: SearchResult) => {
    if (r.kind === "person") selectRef.current(r.id);
    else selectGroupRef.current(r.gi);
    setQuery("");
    setSearchIdx(0);
  };

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100vh",
        background: "var(--cream)",
        overflow: "hidden",
        color: "var(--ink)",
        touchAction: "none",
      }}
    >
      <style>{`
        .pepl-pill { transition: transform 120ms ease, background-color 150ms ease; }
        .pepl-pill:active { transform: scale(0.96); }
        .pepl-pill:focus-visible { outline: 2px solid rgba(145,180,249,0.8); outline-offset: 2px; }
        .pepl-item { transition: transform 120ms ease, background-color 150ms ease; }
        .pepl-item:hover { background-color: rgba(254,224,174,0.38); }
        .pepl-item:active { transform: scale(0.96); }
        .pepl-item:focus-visible { outline: 2px solid rgba(145,180,249,0.8); outline-offset: -1px; }
        .pepl-group { animation: peplRise 260ms ease-out backwards; }
        @keyframes peplRise {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: none; }
        }
        /* the focus veil's cross-fade — opacity only, so the compositor owns
           it and the blur radius never animates over a live canvas */
        /* --lens-r: 0px is the no-hole default, so a veil that mounts before
           the first frame writes is a plain sheet, never a flash of clarity */
        .pepl-veil {
          transition: opacity ${VEIL_MS}ms cubic-bezier(0.4, 0, 0.2, 1);
          --lens-x: 50%; --lens-y: 50%; --lens-r: 0px;
        }
        @media (prefers-reduced-motion: reduce) {
          .pepl-group { animation: none; }
          .pepl-pill:active, .pepl-item:active { transform: none; }
          /* same end state, no travel — the scene's own reduced path snaps too */
          .pepl-veil { transition: none; }
        }
        .pepl-search { transition: box-shadow 150ms ease; }
        .pepl-search:focus {
          outline: 2px solid rgba(145,180,249,0.8);
          outline-offset: 1px;
        }
        .pepl-search::placeholder { color: rgba(26,25,24,0.30); }
      `}</style>
      <div ref={wrapRef} style={{ position: "absolute", inset: 0, touchAction: "none" }}>
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>

      {/* the focus veil — the room softens and dims ~5% on selection so the
          popped elements carry the attention. THE NUMBERS AND THE
          sibling-order law live at VEIL_DIM up top; every widget below this
          line is above it in paint order, and must stay there to stay sharp. */}
      <div
        ref={veilRef}
        className="pepl-veil"
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          opacity: veilOn ? 1 : 0,
          background: `rgba(38,36,44,${VEIL_DIM})`,
          backdropFilter: veilMounted ? `blur(${VEIL_BLUR_PX}px)` : "none",
          /* the clarity lens — law (d): the hole cuts the ink AND the blur */
          maskImage: veilMounted ? LENS_MASK : "none",
          WebkitMaskImage: veilMounted ? LENS_MASK : "none",
        }}
      />

      {/* RSVP stamp burst around the focused dot — above the bubble, so a
          burst is never half-eaten by the lens */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <div
          ref={stampsRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            pointerEvents: "none",
            willChange: "transform",
            transformOrigin: "0 0",
          }}
        >
          {stamps && <StampBurst data={stamps} on={stamps.on} />}
        </div>
        {peeling && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              pointerEvents: "none",
              transform: `translate(${peeling.at.x}px, ${peeling.at.y}px) scale(${peeling.at.k})`,
              transformOrigin: "0 0",
            }}
          >
            <StampBurst data={peeling} on={false} />
          </div>
        )}
      </div>

      {/* widgets — on top of everything, each one mounted only by its pill */}
      {widgets.ticker && <TagTicker />}
      {widgets.hometowns && <HometownMap bottom={floor} />}
      {widgets.connections && (
        <ConnectionsLegend
          edgeOn={edgeOn}
          onToggle={(type) => setEdgeOn((s) => ({ ...s, [type]: !s[type] }))}
          bottom={legendBottom}
          ui={ui}
          /* selection speaks through the same signal the rest of the scene
             reads; the legend never fetches — it is handed what is already
             here, and an empty list means "the record has not landed" */
          focusKey={focusKey}
          focusEdges={relEdges}
          nameOf={personName}
        />
      )}

      {/* the widget pills — the clean field is the default; this row is how
          each overlay comes back */}
      <div
        role="group"
        aria-label="overlays"
        style={{
          position: "absolute",
          left: 20,
          bottom: floor,
          display: "flex",
          gap: 8,
        }}
      >
        {(["connections", "hometowns", "ticker"] as const).map((k) => (
          <button
            key={k}
            className="pepl-pill"
            onClick={() => setWidgets((s) => ({ ...s, [k]: !s[k] }))}
            aria-pressed={widgets[k]}
            style={pill(widgets[k])}
          >
            {k}
          </button>
        ))}
      </div>

      {/* THEIR THREADS — the connect surface: what they said they are looking
          for, then who exactly the room found for it. Rows open the receipt
          (both sides, verbatim) and fly you to the person.

          TWO SOURCES, both baked by scripts/emit-graph.ts into the person
          record fetched on focus:
          · `edges` — RANKED BY THE EMITTER (8 toward-you + 12 other, a human's
            pinned_match first). Render that order; never re-rank here.
          · `answers.seeking` — their verbatim answer to "who are you looking
            for?", the response the seek matching ran against (the row `via`
            labels derive from it). Introduced as THEIR answer, never as our
            claim, and absent when they left it blank.

          DIVISION OF LABOR: the connections box (bottom left) answers "how
          many" and stays non-interactive; THIS widget answers "who exactly, in
          their own words" and owns click-to-receipt; the receipt dialog owns
          the quotes per tie. Do not blur those lines in either direction —
          NORTH-STAR addendum 6 moves the named ties HERE for good.

          A human corrects any of it at ONE station: data/graph-overrides.csv
          (pinned_match reorders, hide removes) + a re-run of the emit — never
          by hand-editing public/graph/*. */}
      {focusKey && !indexOpen && profile && relEdges.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: 68,
            right: 20,
            width: 238,
            padding: "12px 14px",
            borderRadius: 0,
            background: "rgba(255,253,251,0.82)",
            backdropFilter: "blur(14px)",
            boxShadow: shadow,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-hedvig), Georgia, serif",
              fontSize: 15,
              letterSpacing: "0.01em",
              color: "rgba(38,36,44,0.6)",
              marginBottom: 4,
            }}
          >
            their threads
          </div>
          {/* how THEY said they want to connect — the question the sections
              below are the room's answer to. Their words, labelled as theirs;
              clamped to three lines because the widget is a peek. */}
          {seeking && (
            <div style={{ marginBottom: 8 }}>
              <div
                style={{
                  ...ui,
                  textTransform: "none",
                  fontSize: 9,
                  letterSpacing: "0.05em",
                  color: "rgba(26,25,24,0.36)",
                }}
              >
                Their answer · who they’re looking for
              </div>
              <div
                style={{
                  fontFamily: "var(--font-hedvig), Georgia, serif",
                  fontSize: 12,
                  lineHeight: 1.4,
                  color: "rgba(26,25,24,0.7)",
                  marginTop: 3,
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  WebkitLineClamp: 3,
                  overflow: "hidden",
                }}
              >
                “{seeking}”
              </div>
            </div>
          )}
          {/* the list peeks at ~100px and scrolls — the same peek the index
              dropdown shows, and one row deeper than it used to be now that
              finding people is what this widget is for */}
          <div style={{ maxHeight: 104, overflowY: "auto" }}>
          {REL_SECTIONS.map((sec) => {
            const rows = relEdges
              .map((e, i) => ({ e, i }))
              .filter(({ e }) => sectionOf(e) === sec.key);
            if (rows.length === 0) return null;
            return (
              <div key={sec.key} style={{ marginTop: 8 }}>
                <div
                  style={{
                    ...ui,
                    textTransform: "none",
                    fontSize: 9,
                    letterSpacing: "0.05em",
                    color: "rgba(26,25,24,0.36)",
                    paddingBottom: 3,
                    borderBottom: "1px solid rgba(38,36,44,0.05)",
                    marginBottom: 3,
                  }}
                >
                  {sec.title}
                </div>
                {rows.map(({ e, i }) => (
                  <button
                    key={i}
                    className="pepl-item"
                    onClick={() => setReceiptOpen(i)}
                    style={{
                      ...ui,
                      textTransform: "none",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      padding: "4px 5px",
                      border: "none",
                      borderRadius: 0,
                      background: "transparent",
                      color: "rgba(26,25,24,0.68)",
                      fontSize: 11,
                      letterSpacing: "0.015em",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ textTransform: "capitalize", whiteSpace: "nowrap" }}>
                      {personName(e.targetId).toLowerCase()}
                    </span>
                    <span
                      style={{
                        fontSize: 8.5,
                        color: "rgba(26,25,24,0.34)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.via}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          </div>
        </div>
      )}

      {/* the receipt dialog: both sides of one thread, verbatim */}
      {receiptOpen !== null && relEdges[receiptOpen] && (
        <div
          onClick={() => setReceiptOpen(null)}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(38,36,44,0.16)",
          }}
        >
          <div
            onClick={(ev) => ev.stopPropagation()}
            style={{
              width: 360,
              maxWidth: "calc(100vw - 48px)",
              maxHeight: "calc(100vh - 96px)",
              overflowY: "auto",
              padding: "18px 20px 16px",
              borderRadius: 0,
              background: "rgba(255,253,251,0.97)",
              boxShadow:
                "0 18px 50px rgba(38,36,44,0.18), inset 0 0 0 1px rgba(255,255,255,0.55), 0 0 0 1px rgba(38,36,44,0.045)",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-hedvig), Georgia, serif",
                fontSize: 19,
                color: "rgba(26,25,24,0.82)",
                textTransform: "capitalize",
              }}
            >
              {personName(relEdges[receiptOpen].targetId).toLowerCase()}
            </div>
            <div style={{ ...ui, textTransform: "none", fontSize: 9.5, color: "rgba(26,25,24,0.4)", marginTop: 3 }}>
              {REL_SECTIONS.find((s) => s.key === sectionOf(relEdges[receiptOpen]))?.title.toLowerCase()} ·{" "}
              {relEdges[receiptOpen].via}
            </div>
            {([
              ["you", relEdges[receiptOpen].receipt?.yours],
              ["them", relEdges[receiptOpen].receipt?.theirs],
            ] as const).map(([who, r]) =>
              r ? (
                <div key={who} style={{ marginTop: 12 }}>
                  <div style={{ ...ui, textTransform: "none", fontSize: 9, color: "rgba(26,25,24,0.35)" }}>
                    {who} · {r.field}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-hedvig), Georgia, serif",
                      fontSize: 13.5,
                      lineHeight: 1.45,
                      color: "rgba(26,25,24,0.74)",
                      marginTop: 3,
                    }}
                  >
                    “{r.quote}”
                  </div>
                </div>
              ) : null,
            )}
            {!relEdges[receiptOpen].receipt && (
              <div style={{ ...ui, textTransform: "none", fontSize: 10, color: "rgba(26,25,24,0.42)", marginTop: 12 }}>
                no quoted answer behind this thread — the tie itself is the receipt
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button
                className="pepl-item"
                onClick={() => {
                  const target = relEdges[receiptOpen].targetId;
                  setReceiptOpen(null);
                  selectRef.current(target);
                }}
                style={{ ...ui, flex: 1, padding: "7px 0", border: "none", borderRadius: 0, background: "rgba(145,180,249,0.22)", color: "rgba(26,25,24,0.72)", cursor: "pointer" }}
              >
                find them in the room
              </button>
              <button
                className="pepl-item"
                onClick={() => setReceiptOpen(null)}
                style={{ ...ui, padding: "7px 12px", border: "none", borderRadius: 0, background: "rgba(26,25,24,0.05)", color: "rgba(26,25,24,0.52)", cursor: "pointer" }}
              >
                close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* reduced-motion teleport fade */}
      <div
        ref={fadeRef}
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--cream)",
          opacity: 0,
          pointerEvents: "none",
        }}
      />

      {err && (
        <pre
          style={{
            ...ui,
            position: "absolute",
            top: 20,
            left: 20,
            right: 20,
            whiteSpace: "pre-wrap",
            textTransform: "none",
            lineHeight: 1.6,
            color: "#8a3b3b",
            background: "rgba(255,253,251,0.9)",
            padding: "12px 14px",
            borderRadius: 10,
            boxShadow: shadow,
            margin: 0,
          }}
        >
          {err}
        </pre>
      )}

      {/* search — flies the bubble to a person or frames a group */}
      <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", width: 264 }}>
        <input
          className="pepl-search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearchIdx(0);
          }}
          onKeyDown={(e) => {
            /* IME composition commit must not pick a result
               (keyCode 229 covers Safari's post-compositionend Enter) */
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSearchIdx((i) => Math.min(i + 1, searchResults.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSearchIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && searchResults.length > 0) {
              pickResult(searchResults[searchSel]);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setQuery("");
            }
          }}
          placeholder="search people + groups"
          aria-label="search people and groups"
          style={{
            ...ui,
            textTransform: "none",
            width: "100%",
            padding: "9px 15px",
            border: "none",
            borderRadius: 999,
            background: "rgba(255,253,251,0.72)",
            backdropFilter: "blur(8px)",
            boxShadow: shadow,
            color: "rgba(26,25,24,0.78)",
            fontSize: 11.5,
            letterSpacing: "0.03em",
          }}
        />
        {searchResults.length > 0 && (
          <div
            className="pepl-group"
            style={{
              marginTop: 6,
              borderRadius: 12,
              background: "rgba(255,253,251,0.86)",
              backdropFilter: "blur(14px)",
              boxShadow:
                "inset 0 0 0 1px rgba(255,255,255,0.55), 0 0 0 1px rgba(38,36,44,0.045)",
              padding: 6,
              maxHeight: 296,
              overflowY: "auto",
            }}
          >
            {searchResults.map((r, i) => (
              <button
                key={r.kind === "person" ? r.id : `g-${r.gi}`}
                className="pepl-item"
                onMouseDown={(e) => {
                  if (e.button !== 0) return; // right/middle click stays native
                  e.preventDefault(); // keep the input's blur from eating the click
                  pickResult(r);
                }}
                style={{
                  ...ui,
                  textTransform: "capitalize",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 9px",
                  border: "none",
                  borderRadius: 7,
                  background: i === searchSel ? "rgba(254,224,174,0.38)" : "transparent",
                  color: "rgba(26,25,24,0.72)",
                  fontSize: 11.5,
                  letterSpacing: "0.015em",
                  cursor: "pointer",
                }}
              >
                <span>{r.label.toLowerCase()}</span>
                <span style={{ fontSize: 9, color: "rgba(26,25,24,0.35)", letterSpacing: "0.08em" }}>
                  {r.sub}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* the mark, top-left */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.svg"
        alt="pepl"
        width={46}
        height={46}
        style={{
          position: "absolute",
          top: 14,
          left: 18,
          opacity: 0.88,
          pointerEvents: "none",
          userSelect: "none",
        }}
      />

      <button
        className="pepl-pill"
        onClick={() => setIndexOpen((v) => !v)}
        style={{ ...pill(indexOpen), position: "absolute", top: 20, right: tuneVisible ? 92 : 20 }}
      >
        index
      </button>

      {indexOpen && (
        <div
          style={{
            position: "absolute",
            top: 68,
            right: tuneVisible ? 92 : 20,
            width: 196,
            /* ~80px of visible list (+ the card's padding), like the
               threads widget — a peek that scrolls, not a page */
            maxHeight: 104,
            overflowY: "auto",
            padding: "12px 14px",
            /* the dropdown is square; only the button that opens it is a pill */
            borderRadius: 0,
            background: "rgba(255,253,251,0.78)",
            backdropFilter: "blur(14px)",
            boxShadow:
              "inset 0 0 0 1px rgba(255,255,255,0.55), 0 0 0 1px rgba(38,36,44,0.045)",
          }}
        >
          {defaultAdapter.groups().map((g, gi) => (
            <div key={g.id} className="pepl-group" style={{ marginBottom: 12, animationDelay: `${gi * 50}ms` }}>
              <div
                style={{
                  ...ui,
                  fontSize: 9,
                  letterSpacing: "0.14em",
                  color: "rgba(26,25,24,0.34)",
                  paddingBottom: 5,
                  marginBottom: 4,
                  borderBottom: "1px solid rgba(38,36,44,0.05)",
                }}
              >
                {g.name.toLowerCase()}
              </div>
              {defaultAdapter.people().filter((p) => p.groupId === g.id).map((p) => (
                <button
                  key={p.id}
                  className="pepl-item"
                  onClick={() => selectRef.current(p.id)}
                  style={{
                    ...ui,
                    textTransform: "capitalize",
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "4px 6px",
                    border: "none",
                    borderRadius: 6,
                    background: "transparent",
                    color: "rgba(26,25,24,0.62)",
                    fontSize: 11.5,
                    letterSpacing: "0.015em",
                    cursor: "pointer",
                  }}
                >
                  {p.name.toLowerCase()}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {tuneVisible && (
        <button className="pepl-pill" onClick={togglePanel} style={{ ...pill(panelOpen), position: "absolute", top: 20, right: 20 }}>
          {panelOpen ? "hide" : "tune"}
        </button>
      )}

      {tuneVisible && panelOpen && (
        <div
          style={{
            position: "absolute",
            top: 56,
            right: 20,
            width: 218,
            maxHeight: "calc(100vh - 96px)",
            overflowY: "auto",
            padding: "14px 16px",
            borderRadius: 12,
            background: "rgba(255,253,251,0.70)",
            backdropFilter: "blur(14px)",
            boxShadow:
              "inset 0 0 0 1px rgba(255,255,255,0.55), 0 0 0 1px rgba(38,36,44,0.045)",
          }}
        >
          {/* board field choice */}
          <div style={{ ...ui, color: "rgba(26,25,24,0.28)", marginBottom: 8 }}>board field</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {(["weather", "cartography", "stars"] as const).map((f) => (
              <button
                key={f}
                className="pepl-item"
                onClick={() => setParams((pr) => ({ ...pr, field: f }))}
                style={{
                  ...ui,
                  flex: 1,
                  padding: "6px 0",
                  border: "none",
                  borderRadius: 7,
                  background: params.field === f ? "rgba(145,180,249,0.25)" : "rgba(26,25,24,0.03)",
                  color: params.field === f ? "rgba(26,25,24,0.8)" : "rgba(26,25,24,0.45)",
                  cursor: "pointer",
                  fontSize: 9,
                  textAlign: "center",
                }}
              >
                {f === "cartography" ? "carto" : f}
              </button>
            ))}
          </div>

          {PANEL_GROUPS.map((g, gi) => (
            <div key={g.name} className="pepl-group" style={{ marginTop: gi ? 16 : 0, animationDelay: `${gi * 45}ms` }}>
              <div
                style={{
                  ...ui,
                  fontSize: 9,
                  letterSpacing: "0.14em",
                  color: "rgba(26,25,24,0.34)",
                  marginBottom: 9,
                  paddingBottom: 6,
                  borderBottom: "1px solid rgba(38,36,44,0.05)",
                }}
              >
                {g.name}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {g.items.map((c) => (
                  <label key={c.key} style={{ display: "block" }}>
                    <div
                      style={{
                        ...ui,
                        display: "flex",
                        justifyContent: "space-between",
                        color: "rgba(26,25,24,0.42)",
                        marginBottom: 4,
                      }}
                    >
                      <span>{c.label}</span>
                      <span style={{ color: "rgba(26,25,24,0.72)", fontVariantNumeric: "tabular-nums" }}>
                        {fmt(params[c.key], c.step)}
                        {c.unit || ""}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={c.min}
                      max={c.max}
                      step={c.step}
                      value={params[c.key]}
                      onChange={(e) =>
                        setParams((pr) => ({ ...pr, [c.key]: parseFloat(e.target.value) }))
                      }
                      style={{ width: "100%", accentColor: "#1a1918", height: 14, cursor: "pointer" }}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}

          <button
            className="pepl-item"
            onClick={() => setParams((pr) => ({ ...pr, exportQuality: !pr.exportQuality }))}
            style={{
              ...ui,
              width: "100%",
              marginTop: 14,
              padding: "6px 0",
              border: "none",
              borderRadius: 7,
              background: params.exportQuality ? "rgba(26,25,24,0.09)" : "rgba(26,25,24,0.04)",
              color: "rgba(26,25,24,0.52)",
              cursor: "pointer",
            }}
          >
            export quality {params.exportQuality ? "on" : "off"}
          </button>

          <button
            className="pepl-item"
            onClick={() => setParams({ ...INITIAL })}
            style={{
              ...ui,
              width: "100%",
              marginTop: 8,
              padding: "6px 0",
              border: "none",
              borderRadius: 7,
              background: "rgba(26,25,24,0.05)",
              color: "rgba(26,25,24,0.52)",
              cursor: "pointer",
            }}
          >
            reset
          </button>
        </div>
      )}

      {/* LAST child on purpose: the veil grains everything below it —
          scene, ticker, map, pills, logo — the shader could never reach
          the DOM widgets (they are siblings of the canvas, not pixels) */}
      <GrainVeil paramsRef={paramsRef} />
    </div>
  );
}
