"use client";

/**
 * GraphLab — the /graph room: three lenses over ONE baked graph.
 *
 * Ported from the standalone prototype (scratchpad/graph-lab.html), with the two
 * layout functions deliberately left behind: `simTick` and `ringLayout` ran in the
 * browser there, but here every node arrives with its position already baked per
 * lens (`node.pos.web | .why | .seek`, emitted by scripts/emit-graph.ts). The only
 * motion left is the tween between lenses.
 *
 * Laws honoured here:
 *  - colours come from passport/tokens.css ONLY — the canvas reads them with
 *    getComputedStyle (app/universe/lib/palette.ts convention). No invented hexes.
 *  - a claim without a receipt is a bug: connection rows open the verbatim quotes
 *    from the person record. If the record is missing we say so in the modal and
 *    never stamp "RECEIPT RESOLVED".
 *  - the dragged CSV never leaves the browser: papaparse runs client-side and the
 *    only thing we do with it is check it IS this party's guest list.
 *
 * Imperative canvas loop with refs (no per-frame React state), exactly like
 * app/universe/UniverseGraph.tsx.
 */

import Papa from "papaparse";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./graph.module.css";

/* ============================================================ the contract */

type Lens = "web" | "why" | "seek";
type EdgeType = "school" | "company" | "why" | "seek";

interface GNode {
  id: string;
  name: string;
  title: string;
  school: string | null;
  company: string | null;
  free: boolean;
  motive: string | null;
  mission: string | null;
  impact: string | null;
  asp: string | null;
  deg: number;
  pos: Partial<Record<Lens, [number, number]>>;
}

interface GEdge {
  s: string;
  t: string;
  type: EdgeType;
  via: string;
  m?: boolean;
  score?: number;
}

interface Stages {
  rows: number;
  approved: number;
  unique: number;
  schools: number;
  companies: number;
  convictions: number;
  seekEdges: number;
  mutuals: number;
  whyEdges: number;
}

interface GMeta {
  people: number;
  built: string;
  counts?: Record<string, number>;
  stages?: Partial<Stages>;
  guestIds?: string[];
}

interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  meta: GMeta;
}

interface ReceiptSide {
  field: string;
  quote: string;
}

interface PersonEdge {
  targetId: string;
  type: EdgeType;
  direction?: string;
  strength?: number;
  via: string;
  receipt?: { yours?: ReceiptSide; theirs?: ReceiptSide };
}

interface PersonRecord {
  personId: string;
  name: string;
  storyline?: string;
  answers?: Record<string, string>;
  edges?: PersonEdge[];
  highlights?: { kind: string; text: string; targets?: string[] }[];
}

/* ====================================================== tokens → canvas */

interface Tokens {
  spectrum: string[];
  ink: string;
  muted: string;
  faint: string;
  border: string;
  affinity: string;
  sans: string;
  mono: string;
}

// Mirrors the shipped values in passport/tokens.css so the canvas still renders
// if the stylesheet is slow/absent (same guarantee palette.ts makes).
const FALLBACK_TOKENS: Tokens = {
  spectrum: ["#e3aab2", "#e0a877", "#d9b96e", "#a8c18e", "#94b0d4", "#7f9fc9", "#c9b6d9", "#9fc4bb"],
  ink: "#1b1b1f",
  muted: "#6b6b74",
  faint: "#9a9aa2",
  border: "#e7e4de",
  affinity: "#e7e5e0",
  sans: "ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, Menlo, monospace",
};

function readTokens(el: HTMLElement | null): Tokens {
  if (typeof document === "undefined" || !el) return FALLBACK_TOKENS;
  const s = getComputedStyle(el);
  const read = (name: string, fb: string) => {
    const v = s.getPropertyValue(name).trim();
    return v.length > 0 ? v : fb;
  };
  const spectrum: string[] = [];
  for (let i = 0; i < 8; i++) {
    const v = s.getPropertyValue(`--usp-spectrum-${i}`).trim();
    if (v) spectrum.push(v);
  }
  return {
    spectrum: spectrum.length > 0 ? spectrum : FALLBACK_TOKENS.spectrum,
    ink: read("--usp-ink", FALLBACK_TOKENS.ink),
    muted: read("--usp-ink-muted", FALLBACK_TOKENS.muted),
    faint: read("--usp-ink-faint", FALLBACK_TOKENS.faint),
    border: read("--usp-border", FALLBACK_TOKENS.border),
    affinity: read("--usp-affinity", FALLBACK_TOKENS.affinity),
    sans: read("--usp-font-sans", FALLBACK_TOKENS.sans),
    mono: read("--usp-font-mono", FALLBACK_TOKENS.mono),
  };
}

/* ================================================================ helpers */

const LENSES: { key: Lens; label: string; sub: string }[] = [
  { key: "web", label: "I · The Web", sub: "FIG. 1 — who shares your world · schools solid, companies dashed" },
  { key: "why", label: "II · Currents", sub: "FIG. 2 — who shares your why · grouped by creative motive · convictions as chips" },
  { key: "seek", label: "III · The Exchange", sub: "FIG. 3 — who is looking for whom · grouped by craft · warm = toward you" },
];

const ANSWER_LABEL: Record<string, string> = {
  goal: "ULTIMATE GOAL",
  drew: "WHAT DREW THEM HERE",
  seeking: "WHO THEY'RE LOOKING FOR",
  inspiration: "WHO INSPIRES THEM",
  favorite: "FAVORITE THING",
  school: "SCHOOL",
  company: "COMPANY",
  title: "WHAT THEY DO",
  hometown: "HOMETOWN",
  conviction: "CONVICTION TAG",
  craft: "CRAFT",
};
const ANSWER_ORDER = ["goal", "drew", "seeking", "inspiration", "favorite"];
const labelOf = (f: string) => ANSWER_LABEL[f] ?? f.replace(/[_-]+/g, " ").toUpperCase();
/** a verbatim answer-sheet quote is introduced by its question… */
const fieldQ = (f: string) => `Q · ${labelOf(f)}`;
/** …a profile cell read off the graph is introduced as a FIELD, never as a quote. */
const fieldF = (f: string) => `FIELD · ${labelOf(f)}`;

const TYPE_BADGE: Record<EdgeType, string> = {
  school: styles.bSchool,
  company: styles.bCompany,
  why: styles.bWhy,
  seek: styles.bSeekOut,
};

const pretty = (s: string) => s.replace(/[_-]+/g, " ");
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function posOf(n: GNode, lens: Lens): [number, number] {
  return n.pos?.[lens] ?? n.pos?.web ?? [0, 0];
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Port of the prototype's `hl()` — but as data, so React does the escaping. */
function highlightParts(text: string, via?: string): { t: string; on: boolean }[] {
  if (!via) return [{ t: text, on: false }];
  const words = via
    .toLowerCase()
    .split(/[^a-z0-9']+/i)
    .filter((w) => w.length > 3)
    .map(escapeRe);
  if (words.length === 0) return [{ t: text, on: false }];
  const re = new RegExp(`(${words.join("|")})`, "ig");
  const out: { t: string; on: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: text.slice(last, i), on: false });
    out.push({ t: m[0], on: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), on: false });
  return out;
}

/* ------------------------------------------------- receipt provenance
 * Four honestly-different states. The copy must name the one that actually
 * happened — claiming "the record did not load" when it loaded fine (a
 * school/company edge simply carries no answer-sheet quote) is a lie about
 * provenance, and provenance is the whole product.
 */

type RecordState = "idle" | "loading" | "ok" | "missing";
type ReceiptSource = "verbatim" | "fields" | "record-loading" | "record-missing";

export function receiptSource(hasYours: boolean, hasTheirs: boolean, recordState: RecordState): ReceiptSource {
  if (hasYours && hasTheirs) return "verbatim";
  if (recordState === "missing") return "record-missing";
  if (recordState === "ok") return "fields";
  return "record-loading";
}

const MATCH_NOTE: Record<EdgeType, string> = {
  why: "SHARED CONVICTION TAG (LLM-EXTRACTED, QUOTE-GROUNDED)",
  seek: "SEEKING ↔ WHAT THEY DO (GUARDED MATCH)",
  school: "EXACT FIELD MATCH AFTER CANONICALIZATION",
  company: "EXACT FIELD MATCH AFTER CANONICALIZATION",
};

/**
 * `oneSided` disambiguates the "fields" state: it's true when exactly one
 * column above is a verbatim answer-sheet quote (rendered under `Q ·`) and
 * the other is a profile field (`FIELD ·`) — as opposed to neither column
 * having a quote at all. Both are honestly "fields" (not both-verbatim), but
 * they are NOT the same claim: 60 shipped receipts are one-sided, and saying
 * "NO ANSWER-SHEET QUOTE ON THIS EDGE" while a `Q ·` label sits right above
 * it is a lie about provenance.
 */
export function provenanceFor(source: ReceiptSource, type: EdgeType, personId: string, oneSided = false): string {
  const match = MATCH_NOTE[type];
  switch (source) {
    case "verbatim":
      return `SRC · SIGNUP SHEET (VERBATIM) · MATCH · ${match} · RECEIPT RESOLVED ✓`;
    case "fields":
      return oneSided
        ? `SRC · SIGNUP SHEET (VERBATIM, ONE SIDE) + THE GRAPH EDGE · MATCH · ${match} · ONE SIDE QUOTES THE SHEET — THE OTHER COLUMN IS ITS FIELD VALUE`
        : `SRC · THE GRAPH EDGE + BOTH PROFILE FIELDS · MATCH · ${match} · NO ANSWER-SHEET QUOTE ON THIS EDGE — THE FIELDS ABOVE ARE THE RECEIPT`;
    case "record-loading":
      return `READING /graph/people/${personId}.json — SHOWING THE EDGE'S FIELD VALUES UNTIL THE VERBATIM QUOTES ARRIVE.`;
    case "record-missing":
      return `/graph/people/${personId}.json DID NOT LOAD — VERBATIM QUOTES ARE WITHHELD, NOT GUESSED. THE EDGE AND FIELDS ABOVE ARE THE GRAPH'S OWN.`;
  }
}

/** The cell a node can show for an edge type when no answer-sheet quote exists. */
export function fieldFallback(n: GNode, type: EdgeType): { field: string; quote: string } | null {
  if (type === "school") return n.school ? { field: "school", quote: n.school } : null;
  if (type === "company") {
    if (n.company) return { field: "company", quote: n.company };
    return n.free ? { field: "company", quote: "independent" } : null;
  }
  if (type === "why") {
    const tag = n.mission ?? n.impact;
    return tag ? { field: "conviction", quote: pretty(tag) } : null;
  }
  const craft = [n.title, n.asp ? pretty(n.asp) : null].filter(Boolean).join(" · ");
  return craft ? { field: "craft", quote: craft } : null;
}

/* ------------------------------------------------- the caption strip
 * The strip must never wait on an unrelated re-render to fill in: these two
 * helpers are what the component uses to decide "fetch this record now" and
 * "what does the strip say with what I have".
 */

export function needsRecordFetch(lens: Lens, id: string | null, cached: (id: string) => boolean): boolean {
  return lens === "why" && Boolean(id) && !cached(id as string);
}

export function stripQuoteFrom(record: PersonRecord | null | undefined): string | null {
  return record?.answers?.goal ?? record?.answers?.drew ?? null;
}

/* --------------------------------------------- Step 0: CSV verification */

type CsvVerdict =
  | { ok: true; rows: number; ids: number; matched: number; ratio: number }
  | { ok: false; code: string; message: string };

function pickIdField(fields: string[]): string | null {
  const norm = (f: string) => f.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (
    fields.find((f) => /^guest_?id$/.test(norm(f))) ??
    fields.find((f) => /^(api_?id|luma_?id|ticket_?id|person_?id)$/.test(norm(f))) ??
    fields.find((f) => /(^|_)id$/.test(norm(f))) ??
    null
  );
}

function verifyGuestList(rows: Record<string, unknown>[], fields: string[], guestIds: string[]): CsvVerdict {
  if (rows.length === 0) {
    return { ok: false, code: "EMPTY_CSV", message: "no data rows — that file has a header and nothing under it." };
  }
  if (guestIds.length === 0) {
    return {
      ok: false,
      code: "GUEST_IDS_UNAVAILABLE",
      message: "graph.json carries no meta.guestIds, so this file cannot be verified against the party list.",
    };
  }
  const idField = pickIdField(fields);
  if (!idField) {
    return {
      ok: false,
      code: "GUEST_ID_COLUMN_MISSING",
      message: "no guest_id column in that CSV. The party export has one — this file is something else.",
    };
  }
  const known = new Set(guestIds.map((g) => String(g).trim()));
  let ids = 0;
  let matched = 0;
  for (const r of rows) {
    const raw = r[idField];
    const v = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    if (!v) continue;
    ids += 1;
    if (known.has(v)) matched += 1;
  }
  if (ids === 0) {
    return { ok: false, code: "GUEST_ID_COLUMN_EMPTY", message: `every "${idField}" cell in that file is blank.` };
  }
  const ratio = matched / ids;
  if (ratio < 0.9) {
    return {
      ok: false,
      code: "GUEST_LIST_MISMATCH",
      message: `${matched} of ${ids} ids match this party's list (${Math.round(ratio * 100)}% — needs 90%). This is a real guest list, but it isn't ours.`,
    };
  }
  return { ok: true, rows: rows.length, ids, matched, ratio };
}

interface Beat {
  label: string;
  detail: string;
}

function buildBeats(meta: GMeta, verdict: Extract<CsvVerdict, { ok: true }>): Beat[] {
  const st = meta.stages ?? {};
  const n = (v: number | undefined) => (typeof v === "number" ? v.toLocaleString() : null);
  const rows = st.rows ?? verdict.rows;
  const approved = st.approved;
  const unique = st.unique ?? meta.people;
  const pending = typeof approved === "number" ? rows - approved : null;
  return [
    {
      label: "Reading the guest list…",
      detail: `${verdict.matched} of ${verdict.ids} ids match the party — verified locally, nothing uploaded`,
    },
    {
      label: n(rows) ? `${n(rows)} rows` : "Counting the rows…",
      detail:
        approved != null
          ? `${n(approved)} approved${pending && pending > 0 ? ` · ${pending} still pending` : ""} → ${n(unique)} people`
          : `${n(unique)} people`,
    },
    {
      label: "Canonicalizing where they come from…",
      detail:
        st.schools != null || st.companies != null
          ? `${n(st.schools) ?? "—"} schools · ${n(st.companies) ?? "—"} companies, each folded to one node`
          : "every school and company folded to one node",
    },
    {
      label: "Reading what they believe…",
      detail:
        st.convictions != null
          ? `convictions extracted for ${n(st.convictions)} — quote-grounded, never invented`
          : "convictions extracted from their own words",
    },
    {
      label: "Matching who is looking for whom…",
      detail:
        st.seekEdges != null
          ? `${n(st.seekEdges)} seeking matches · ${n(st.mutuals) ?? "0"} mutual`
          : "seeking matched against what people actually do",
    },
    {
      label: "Drawing the room…",
      detail:
        st.whyEdges != null
          ? `${n(st.whyEdges)} shared-conviction threads · ${n(meta.people)} placed`
          : `${n(meta.people)} placed by what they share`,
    },
  ];
}

const BEAT_MS = [1500, 1500, 1450, 1500, 1500, 1400];
const ENTER_MS = 1100;

/* ================================================================= view */

type Phase = "entry" | "beats" | "live";

interface ReceiptSideView {
  name: string;
  hue: string;
  /** already-resolved label: "Q · …" for a verbatim answer, "FIELD · …" for a profile cell */
  label: string;
  quote: string;
}

interface ReceiptView {
  type: EdgeType;
  via: string;
  mutual: boolean;
  inbound: boolean;
  source: ReceiptSource;
  left: ReceiptSideView | null;
  right: ReceiptSideView | null;
  prov: string;
}

interface ConnRow {
  key: string;
  otherId: string;
  type: EdgeType;
  via: string;
  inbound: boolean;
  mutual: boolean;
  receipt?: { yours?: ReceiptSide; theirs?: ReceiptSide };
}

export default function GraphLab() {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* ---- data ---- */
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* ---- entry theatre ---- */
  const [phase, setPhase] = useState<Phase | null>(null); // null until we know
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<{ code: string; message: string } | null>(null);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [beatIdx, setBeatIdx] = useState(-1);
  const [entering, setEntering] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /* ---- room state ---- */
  const [lens, setLens] = useState<Lens>("web");
  const [selId, setSelId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [chip, setChip] = useState<{ field: "mission" | "impact"; tag: string } | null>(null);
  const [query, setQuery] = useState("");
  const [record, setRecord] = useState<PersonRecord | null>(null);
  const [recordState, setRecordState] = useState<"idle" | "loading" | "ok" | "missing">("idle");
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  /** bumped whenever a person record lands in the cache (the cache is a ref) */
  const [recordTick, setRecordTick] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- refs the raf loop reads (never React state per frame) ---- */
  const graphRef = useRef<Graph | null>(null);
  const lensRef = useRef<Lens>("web");
  const selRef = useRef<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const chipRef = useRef<{ field: "mission" | "impact"; tag: string } | null>(null);
  const searchSetRef = useRef<Set<string> | null>(null);
  const tokensRef = useRef<Tokens>(FALLBACK_TOKENS);
  const camRef = useRef({ k: 1, x: 0, y: 0 });
  const camFromRef = useRef({ k: 1, x: 0, y: 0 });
  const camToRef = useRef({ k: 1, x: 0, y: 0 });
  const tweenRef = useRef(1);
  const fromPosRef = useRef<Map<string, [number, number]>>(new Map());
  const drawPosRef = useRef<Map<string, [number, number]>>(new Map());
  const sizeRef = useRef({ w: 0, h: 0 });
  const stampsRef = useRef<{ label: string; n: number; x: number; y: number }[]>([]);
  const userMovedRef = useRef(false);
  const recordCache = useRef<Map<string, PersonRecord | null>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const hoverFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<Phase | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  /* ---- Teri's tokens, read once (client-only component: safe at init) ---- */
  const [tokens] = useState<Tokens>(() =>
    readTokens(typeof document === "undefined" ? null : document.documentElement),
  );
  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  /* ------------------------------------------------------- derived data */

  const byId = useMemo(() => {
    const m = new Map<string, GNode>();
    for (const n of graph?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [graph]);

  const adjacency = useMemo(() => {
    const m = new Map<string, GEdge[]>();
    for (const n of graph?.nodes ?? []) m.set(n.id, []);
    for (const e of graph?.edges ?? []) {
      m.get(e.s)?.push(e);
      m.get(e.t)?.push(e);
    }
    return m;
  }, [graph]);

  const motives = useMemo(() => {
    const s = new Set<string>();
    for (const n of graph?.nodes ?? []) if (n.motive) s.add(n.motive);
    return [...s].sort();
  }, [graph]);

  const hueOf = useCallback(
    (n: GNode | null | undefined): string => {
      const pal = tokens.spectrum;
      if (!n?.motive) return tokens.affinity;
      const i = motives.indexOf(n.motive);
      return pal[(i < 0 ? 0 : i) % pal.length];
    },
    [motives, tokens],
  );

  const groupCounts = useMemo(() => {
    const schools = new Map<string, number>();
    const companies = new Map<string, number>();
    for (const n of graph?.nodes ?? []) {
      if (n.school) schools.set(n.school, (schools.get(n.school) ?? 0) + 1);
      if (n.company) companies.set(n.company, (companies.get(n.company) ?? 0) + 1);
    }
    return { schools, companies };
  }, [graph]);

  const chipList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph?.nodes ?? []) {
      if (n.mission) counts.set(`mission|${n.mission}`, (counts.get(`mission|${n.mission}`) ?? 0) + 1);
      if (n.impact) counts.set(`impact|${n.impact}`, (counts.get(`impact|${n.impact}`) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7)
      .map(([key, n], i) => {
        const [field, tag] = key.split("|");
        return { field: field as "mission" | "impact", tag, n, i };
      });
  }, [graph]);

  const stamps = useMemo(() => {
    if (!graph || lens === "web") return [] as { label: string; n: number; x: number; y: number }[];
    const key = lens === "why" ? "motive" : "asp";
    const groups = new Map<string, GNode[]>();
    for (const n of graph.nodes) {
      const v = (n[key as "motive" | "asp"] ?? "").trim();
      if (!v) continue;
      const arr = groups.get(v) ?? [];
      arr.push(n);
      groups.set(v, arr);
    }
    const out: { label: string; n: number; x: number; y: number }[] = [];
    for (const [label, members] of groups) {
      let sx = 0;
      let top = Infinity;
      for (const m of members) {
        const [x, y] = posOf(m, lens);
        sx += x;
        if (y < top) top = y;
      }
      out.push({ label: pretty(label), n: members.length, x: sx / members.length, y: top - 18 });
    }
    return out;
  }, [graph, lens]);

  const selNode = selId ? byId.get(selId) ?? null : null;
  const hoverNode = hoverId ? byId.get(hoverId) ?? null : null;

  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !graph) return [] as GNode[];
    return graph.nodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          (n.school ?? "").toLowerCase().includes(q) ||
          (n.company ?? "").toLowerCase().includes(q) ||
          (n.title ?? "").toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [query, graph]);

  useEffect(() => {
    searchSetRef.current = searchHits.length > 0 ? new Set(searchHits.map((h) => h.id)) : null;
  }, [searchHits]);

  /* -------------------------------------------------------- data + entry */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/graph/graph.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`graph.json → HTTP ${res.status}`);
        const data = (await res.json()) as Graph;
        if (cancelled) return;
        if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error("graph.json is missing nodes/edges");
        graphRef.current = data;
        setGraph(data);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "graph.json could not be read");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Decide the entry once, before paint: hash deep links and return visits skip
  // the theatre entirely.
  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem("usp-graph-seen") === "1";
    } catch {
      seen = false;
    }
    const deepLink = typeof location !== "undefined" && location.hash.length > 1;
    setPhase(deepLink || seen ? "live" : "entry");
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (hoverFetchTimer.current) clearTimeout(hoverFetchTimer.current);
    };
  }, []);

  const goLive = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    try {
      sessionStorage.setItem("usp-graph-seen", "1");
    } catch {
      /* private mode — the theatre simply plays again next visit */
    }
    setEntering(false);
    setPhase("live");
  }, []);

  const showToast = useCallback((msg: string | null) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    if (msg) toastTimer.current = setTimeout(() => setToast(null), 3400);
  }, []);

  const runBeats = useCallback(
    (meta: GMeta, verdict: Extract<CsvVerdict, { ok: true }>) => {
      const list = buildBeats(meta, verdict);
      setBeats(list);
      setBeatIdx(-1);
      setPhase("beats");
      let t = 320;
      BEAT_MS.forEach((d, i) => {
        timersRef.current.push(setTimeout(() => setBeatIdx(i), t));
        t += d;
      });
      timersRef.current.push(setTimeout(() => setEntering(true), t));
      timersRef.current.push(setTimeout(() => goLive(), t + ENTER_MS));
    },
    [goLive],
  );

  const onFile = useCallback(
    (file: File) => {
      setFileName(file.name);
      setEntryError(null);
      const g = graphRef.current;
      if (!g) {
        setEntryError({
          code: "GRAPH_ARTIFACT_UNAVAILABLE",
          message: loadError ?? "the baked graph has not loaded yet — try again in a moment.",
        });
        return;
      }
      // Local parse only. The file is never uploaded anywhere.
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          const verdict = verifyGuestList(res.data, res.meta.fields ?? [], g.meta?.guestIds ?? []);
          if (!verdict.ok) {
            setEntryError({ code: verdict.code, message: verdict.message });
            return;
          }
          runBeats(g.meta, verdict);
        },
        error: (err: Error) => setEntryError({ code: "CSV_PARSE_FAILED", message: err.message }),
      });
    },
    [loadError, runBeats],
  );

  /* ----------------------------------------------------------- selection */

  const loadRecord = useCallback(async (id: string) => {
    const cache = recordCache.current;
    if (cache.has(id)) {
      const cached = cache.get(id) ?? null;
      if (selRef.current === id) {
        setRecord(cached);
        setRecordState(cached ? "ok" : "missing");
      }
      return;
    }
    if (inFlightRef.current.has(id)) return; // hover-dwell and the strip can both ask
    inFlightRef.current.add(id);
    if (selRef.current === id) setRecordState("loading");
    try {
      const res = await fetch(`/graph/people/${encodeURIComponent(id)}.json`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rec = (await res.json()) as PersonRecord;
      cache.set(id, rec);
      if (selRef.current === id) {
        setRecord(rec);
        setRecordState("ok");
      }
    } catch {
      cache.set(id, null);
      if (selRef.current === id) {
        setRecord(null);
        setRecordState("missing");
      }
    } finally {
      inFlightRef.current.delete(id);
      // the cache is a ref: tick so anything reading it (the caption strip)
      // re-renders the moment a record lands, not on the next unrelated render
      setRecordTick((t) => t + 1);
    }
  }, []);

  const select = useCallback(
    (id: string, opts?: { zoom?: boolean }) => {
      if (!graphRef.current) return;
      if (!graphRef.current.nodes.some((n) => n.id === id)) {
        // fail loud, never silently: a deep link to nobody says so
        showToast(`NO GUEST “${id}” IN THIS GRAPH`);
        return;
      }
      selRef.current = id;
      chipRef.current = null;
      setChip(null);
      setSelId(id);
      setRecord(recordCache.current.get(id) ?? null);
      setRecordState(recordCache.current.get(id) ? "ok" : "idle");
      void loadRecord(id);
      try {
        history.replaceState(null, "", `#${id}`);
      } catch {
        /* non-fatal */
      }
      if (opts?.zoom) {
        const node = graphRef.current.nodes.find((n) => n.id === id);
        if (node) {
          const [x, y] = posOf(node, lensRef.current);
          camRef.current = { k: Math.max(camRef.current.k, 1.6), x, y };
          camToRef.current = { ...camRef.current };
          camFromRef.current = { ...camRef.current };
          tweenRef.current = 1;
          userMovedRef.current = true;
        }
      }
    },
    [loadRecord, showToast],
  );

  const deselect = useCallback(() => {
    selRef.current = null;
    setSelId(null);
    setRecord(null);
    setRecordState("idle");
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* non-fatal */
    }
  }, []);

  // hash deep links (initial + back/forward)
  useEffect(() => {
    if (!graph) return;
    const fromHash = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id) select(id);
    };
    fromHash();
    const onHash = () => fromHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [graph, select]);

  useEffect(() => {
    selRef.current = selId;
  }, [selId]);
  useEffect(() => {
    chipRef.current = chip;
  }, [chip]);
  useEffect(() => {
    hoverRef.current = hoverId;
  }, [hoverId]);

  /* ------------------------------------------------------- lens + camera */

  const fitFor = useCallback((nodes: GNode[], l: Lens, w: number, h: number) => {
    if (nodes.length === 0 || w === 0 || h === 0) return { k: 1, x: 0, y: 0 };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const [x, y] = posOf(n, l);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const k = clamp(Math.min((w - 120) / spanX, (h - 230) / spanY), 0.22, 2.6);
    return { k, x: (minX + maxX) / 2, y: (minY + maxY) / 2 + 24 };
  }, []);

  const switchLens = useCallback(
    (l: Lens) => {
      const g = graphRef.current;
      if (!g) return;
      // freeze the CURRENT drawn positions as the tween origin
      const from = new Map<string, [number, number]>();
      for (const n of g.nodes) {
        const d = drawPosRef.current.get(n.id) ?? posOf(n, lensRef.current);
        from.set(n.id, [d[0], d[1]]);
      }
      fromPosRef.current = from;
      lensRef.current = l;
      setLens(l);
      const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      tweenRef.current = reduced ? 1 : 0;
      camFromRef.current = { ...camRef.current };
      camToRef.current = fitFor(g.nodes, l, sizeRef.current.w, sizeRef.current.h);
      if (reduced) camRef.current = { ...camToRef.current };
      userMovedRef.current = false;
      setChip(null);
      chipRef.current = null;
    },
    [fitFor],
  );

  /* ------------------------------------------------- the canvas raf loop */

  useEffect(() => {
    const canvas = canvasRef.current;
    const shell = shellRef.current;
    if (!canvas || !shell) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    tokensRef.current = readTokens(shell);

    const DPR = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, 2);
    const sizeCanvas = () => {
      const w = shell.clientWidth || window.innerWidth;
      const h = shell.clientHeight || window.innerHeight;
      sizeRef.current = { w, h };
      canvas.width = Math.round(w * DPR);
      canvas.height = Math.round(h * DPR);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const g = graphRef.current;
      if (g && !userMovedRef.current) {
        const fit = fitFor(g.nodes, lensRef.current, w, h);
        camRef.current = { ...fit };
        camFromRef.current = { ...fit };
        camToRef.current = { ...fit };
      }
    };
    sizeCanvas();
    window.addEventListener("resize", sizeCanvas);

    let raf = 0;
    const T0 = performance.now();

    const toScreen = (x: number, y: number): [number, number] => {
      const { w, h } = sizeRef.current;
      const cam = camRef.current;
      return [w / 2 + (x - cam.x) * cam.k, h / 2 + (y - cam.y) * cam.k];
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const g = graphRef.current;
      const { w, h } = sizeRef.current;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!g) return;

      const T = tokensRef.current;
      const L = lensRef.current;
      const sel = selRef.current;
      const hov = hoverRef.current;
      const chipSel = chipRef.current;
      const searchSet = searchSetRef.current;

      if (tweenRef.current < 1) {
        tweenRef.current = Math.min(1, tweenRef.current + 0.045);
        const tt = 1 - Math.pow(1 - tweenRef.current, 3);
        const a = camFromRef.current;
        const b = camToRef.current;
        camRef.current = { k: a.k + (b.k - a.k) * tt, x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt };
      }
      const tt = 1 - Math.pow(1 - tweenRef.current, 3);

      // positions: baked per lens, tweened from the previous lens
      const dp = drawPosRef.current;
      for (const n of g.nodes) {
        const target = posOf(n, L);
        const from = fromPosRef.current.get(n.id) ?? target;
        dp.set(n.id, [from[0] + (target[0] - from[0]) * tt, from[1] + (target[1] - from[1]) * tt]);
      }

      const egoSet = sel
        ? new Set<string>([sel, ...(g.edges.filter((e) => e.s === sel || e.t === sel).map((e) => (e.s === sel ? e.t : e.s)))])
        : null;
      const chipSet = chipSel
        ? new Set(g.nodes.filter((n) => n[chipSel.field] === chipSel.tag).map((n) => n.id))
        : null;
      const focusSet = egoSet ?? chipSet;

      /* ---- edges ---- */
      for (const e of g.edges) {
        const visible =
          L === "web"
            ? e.type === "school" || e.type === "company"
            : L === "why"
              ? e.type === "why" && Boolean(sel || chipSel)
              : e.type === "seek";
        if (!visible) continue;
        const A = dp.get(e.s);
        const B = dp.get(e.t);
        if (!A || !B) continue;
        const inFocus = Boolean(focusSet && focusSet.has(e.s) && focusSet.has(e.t));
        const touchesSel = Boolean(sel && (e.s === sel || e.t === sel));
        if (L === "why" && !(inFocus || touchesSel)) continue;
        if (L === "seek" && focusSet && !touchesSel) continue;
        const baseAlpha = focusSet ? (touchesSel || inFocus ? 0.55 : 0.03) : 0.1;
        const [x1, y1] = toScreen(A[0], A[1]);
        const [x2, y2] = toScreen(B[0], B[1]);
        ctx.beginPath();
        if (e.type === "seek") {
          const mx = (x1 + x2) / 2 + (y2 - y1) * 0.14;
          const my = (y1 + y2) / 2 - (x2 - x1) * 0.14;
          ctx.moveTo(x1, y1);
          ctx.quadraticCurveTo(mx, my, x2, y2);
          const inbound = Boolean(sel && e.t === sel);
          ctx.strokeStyle = inbound ? T.spectrum[1] ?? T.ink : T.spectrum[5] ?? T.ink;
          ctx.lineWidth = touchesSel ? (e.m ? 2.4 : 1.6) : 0.7;
          ctx.globalAlpha = touchesSel ? 0.85 : baseAlpha;
        } else {
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          if (e.type === "why") {
            ctx.strokeStyle = T.spectrum[6] ?? T.ink;
            ctx.lineWidth = 1.3;
            ctx.globalAlpha = 0.7;
          } else {
            ctx.strokeStyle = T.ink;
            ctx.lineWidth = 1;
            ctx.globalAlpha = focusSet ? (touchesSel ? 0.35 : 0.03) : 0.07;
            ctx.setLineDash(e.type === "company" ? [3, 4] : []);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      /* ---- nodes ---- */
      const cam = camRef.current;
      const zoomed = cam.k > 1.15;
      for (const n of g.nodes) {
        const d = dp.get(n.id);
        if (!d) continue;
        const [sx, sy] = toScreen(d[0], d[1]);
        if (sx < -30 || sy < -30 || sx > w + 30 || sy > h + 30) continue;
        const dim = Boolean(focusSet && !focusSet.has(n.id));
        const r = 3.6 + Math.min(Math.sqrt(Math.max(n.deg, 0)) * 1.1, 5);
        ctx.globalAlpha = dim ? 0.12 : 1;
        ctx.beginPath();
        ctx.arc(sx, sy, r * Math.max(cam.k, 0.7), 0, Math.PI * 2);
        ctx.fillStyle = hueOf(n);
        ctx.fill();
        ctx.lineWidth = n.id === sel ? 1.8 : 0.8;
        ctx.strokeStyle = T.ink;
        ctx.globalAlpha = dim ? 0.12 : n.id === sel ? 0.55 : 0.24;
        ctx.stroke();
        ctx.globalAlpha = dim ? 0.12 : 1;
        if (n.id === sel) {
          const breathe = 1 + Math.sin((now - T0) / 300) * 0.22;
          ctx.beginPath();
          ctx.arc(sx, sy, (r + 5) * breathe * Math.max(cam.k, 0.7), 0, Math.PI * 2);
          ctx.strokeStyle = T.ink;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const named =
          n.id === sel ||
          n.id === hov ||
          Boolean(searchSet && searchSet.has(n.id)) ||
          (!dim &&
            (zoomed ||
              Boolean(egoSet && egoSet.has(n.id)) ||
              Boolean(chipSet && chipSet.has(n.id) && cam.k > 0.8) ||
              (n.deg > 5 && cam.k > 0.85)));
        if (named && !dim) {
          ctx.font = `560 11px ${T.sans}`;
          ctx.fillStyle = T.ink;
          ctx.textAlign = "center";
          ctx.fillText(n.name, sx, sy - r * cam.k - 12);
          ctx.font = `9px ${T.mono}`;
          ctx.fillStyle = T.faint;
          ctx.fillText((n.title ?? "").toUpperCase().slice(0, 26), sx, sy - r * cam.k - 2);
        }
        ctx.globalAlpha = 1;
      }

      /* ---- cluster stamps ---- */
      if (L !== "web") {
        ctx.textAlign = "center";
        for (const s of stampsRef.current) {
          const [sx, sy] = toScreen(s.x, s.y);
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(-0.05);
          ctx.font = `10px ${T.mono}`;
          const label = `${s.label.toUpperCase()} · ${s.n}`;
          const bw = ctx.measureText(label).width + 18;
          ctx.globalAlpha = focusSet ? 0.35 : 0.9;
          ctx.strokeStyle = T.border;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(-bw / 2, -11, bw, 20, 10);
          ctx.stroke();
          ctx.fillStyle = T.muted;
          ctx.fillText(label, 0, 3.5);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }
    };
    raf = requestAnimationFrame(draw);

    /* ---- pointer: pan / zoom / pick ---- */
    const pick = (mx: number, my: number): string | null => {
      const g = graphRef.current;
      if (!g) return null;
      let best: string | null = null;
      let bd = 18 * 18;
      for (const n of g.nodes) {
        const d = drawPosRef.current.get(n.id);
        if (!d) continue;
        const [sx, sy] = toScreen(d[0], d[1]);
        const dist = (sx - mx) ** 2 + (sy - my) ** 2;
        if (dist < bd) {
          bd = dist;
          best = n.id;
        }
      }
      return best;
    };

    let drag: { x: number; y: number; cx: number; cy: number } | null = null;
    let moved = false;
    let touchPointer = false;

    const onDown = (e: PointerEvent) => {
      touchPointer = e.pointerType === "touch";
      drag = { x: e.clientX, y: e.clientY, cx: camRef.current.x, cy: camRef.current.y };
      moved = false;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          moved = true;
          userMovedRef.current = true;
          tweenRef.current = Math.max(tweenRef.current, 1);
        }
        camRef.current = { ...camRef.current, x: drag.cx - dx / camRef.current.k, y: drag.cy - dy / camRef.current.k };
        return;
      }
      // phone grammar: no hover on touch — selection replaces it
      if (touchPointer || e.pointerType === "touch") return;
      const id = pick(e.clientX, e.clientY);
      if (id !== hoverRef.current) {
        hoverRef.current = id;
        setHoverId(id);
        if (hoverFetchTimer.current) clearTimeout(hoverFetchTimer.current);
        if (id && !recordCache.current.has(id)) {
          hoverFetchTimer.current = setTimeout(() => {
            const target = hoverRef.current;
            if (target && !recordCache.current.has(target)) void loadRecord(target);
          }, 260);
        }
      }
      canvas.style.cursor = id ? "pointer" : "default";
    };
    const onUp = (e: PointerEvent) => {
      if (!moved) {
        const id = pick(e.clientX, e.clientY);
        if (id) select(id);
        else deselect();
      }
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMovedRef.current = true;
      tweenRef.current = Math.max(tweenRef.current, 1);
      const f = Math.exp(-e.deltaY * 0.0016);
      camRef.current = { ...camRef.current, k: clamp(camRef.current.k * f, 0.25, 6) };
    };
    let pinch: number | null = null;
    const dist2 = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = dist2(e.touches);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        const d = dist2(e.touches);
        userMovedRef.current = true;
        camRef.current = { ...camRef.current, k: clamp((camRef.current.k * d) / pinch, 0.25, 6) };
        pinch = d;
        e.preventDefault();
      }
    };
    const onTouchEnd = () => {
      pinch = null;
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", sizeCanvas);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, [deselect, fitFor, hueOf, loadRecord, select]);

  // stamps live in a ref so the loop never re-subscribes
  useEffect(() => {
    stampsRef.current = stamps;
  }, [stamps]);

  // first fit once the data lands
  useEffect(() => {
    if (!graph) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;
    const fit = fitFor(graph.nodes, lensRef.current, w, h);
    camRef.current = { ...fit };
    camFromRef.current = { ...fit };
    camToRef.current = { ...fit };
  }, [graph, fitFor]);

  useEffect(() => {
    if (phase !== "live" || !graph) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;
    if (!userMovedRef.current) {
      const fit = fitFor(graph.nodes, lensRef.current, w, h);
      camRef.current = { ...fit };
      camToRef.current = { ...fit };
      camFromRef.current = { ...fit };
    }
    showToast(`${graph.meta?.people ?? graph.nodes.length} REAL GUESTS · TAP A DOT · KEYS 1 2 3 SWITCH LENSES`);
  }, [phase, graph, fitFor, showToast]);

  /* --------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (receipt) setReceipt(null);
        else deselect();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (phaseRef.current !== "live") return;
      if (e.key === "1") switchLens("web");
      if (e.key === "2") switchLens("why");
      if (e.key === "3") switchLens("seek");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deselect, receipt, switchLens]);

  /* ------------------------------------------------- connection rows */

  /** Port of the prototype's `rankEdges` — the fallback when the person record
   *  is unavailable. Same ordering the emit script bakes into the record. */
  const rowsFromGraph = useCallback(
    (id: string): ConnRow[] => {
      const list = (adjacency.get(id) ?? []).map((e) => {
        const other = e.s === id ? e.t : e.s;
        const inbound = e.type === "seek" && e.t === id;
        const w = e.type === "seek" ? (e.m ? 100 : inbound ? 90 : 80) : e.type === "why" ? 60 : e.type === "company" ? 40 : 30;
        return { e, other, inbound, w };
      });
      const seen = new Set<string>();
      const out: ConnRow[] = [];
      for (const r of list.sort((a, b) => b.w - a.w)) {
        const k = `${r.other}|${r.e.type}|${r.inbound}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          key: k,
          otherId: r.other,
          type: r.e.type,
          via: r.e.via,
          inbound: r.inbound,
          mutual: Boolean(r.e.m),
        });
      }
      return out;
    },
    [adjacency],
  );

  const rows: ConnRow[] = useMemo(() => {
    if (!selId) return [];
    if (recordState === "ok" && record?.edges?.length) {
      return record.edges.map((e, i) => {
        const dir = (e.direction ?? "").toLowerCase();
        const mutual = dir === "mutual" || dir === "both";
        const inbound = dir === "in" || dir === "inbound" || dir === "toward" || mutual;
        return {
          key: `${e.targetId}|${e.type}|${i}`,
          otherId: e.targetId,
          type: e.type,
          via: e.via,
          inbound,
          mutual,
          receipt: e.receipt,
        };
      });
    }
    return rowsFromGraph(selId);
  }, [selId, record, recordState, rowsFromGraph]);

  const inboundRows = rows.filter((r) => r.type === "seek" && r.inbound);
  const otherRows = rows.filter((r) => !(r.type === "seek" && r.inbound)).slice(0, 12);

  const openReceipt = useCallback(
    (row: ConnRow) => {
      const self = selId ? byId.get(selId) ?? null : null;
      const other = byId.get(row.otherId) ?? null;
      if (!self || !other) return;
      const yours = row.receipt?.yours?.quote ? row.receipt.yours : undefined;
      const theirs = row.receipt?.theirs?.quote ? row.receipt.theirs : undefined;
      const source = receiptSource(Boolean(yours), Boolean(theirs), recordState);
      // each column names its OWN provenance: a verbatim answer or a profile cell
      const sideOf = (node: GNode, quoted: ReceiptSide | undefined): ReceiptSideView | null => {
        if (quoted) {
          return { name: node.name, hue: hueOf(node), label: fieldQ(quoted.field), quote: quoted.quote };
        }
        const cell = fieldFallback(node, row.type);
        return cell ? { name: node.name, hue: hueOf(node), label: fieldF(cell.field), quote: cell.quote } : null;
      };
      setReceipt({
        type: row.type,
        via: row.via,
        mutual: row.mutual,
        inbound: row.inbound,
        source,
        left: sideOf(self, yours),
        right: sideOf(other, theirs),
        prov: provenanceFor(source, row.type, selId ?? "—", Boolean(yours) !== Boolean(theirs)),
      });
    },
    [byId, hueOf, recordState, selId],
  );

  /* ------------------------------------------------------ facts (fallback) */

  const fallbackFacts = useMemo(() => {
    if (!selNode) return [] as string[];
    const out: string[] = [];
    const sc = selNode.school ? groupCounts.schools.get(selNode.school) ?? 0 : 0;
    const cc = selNode.company ? groupCounts.companies.get(selNode.company) ?? 0 : 0;
    if (selNode.school && sc > 1) out.push(`one of ${sc} from ${selNode.school} tonight`);
    if (selNode.company && cc > 1) out.push(`one of ${cc} at ${selNode.company}`);
    if (selNode.mission) out.push(`one of a small group whose mission is ${pretty(selNode.mission)}`);
    if (selNode.impact) out.push(`wants the work to land as ${pretty(selNode.impact)}`);
    return out;
  }, [selNode, groupCounts]);

  /* ---------------------------------------------------------------- view */

  const stripPerson = hoverNode ?? selNode;
  // The strip reads a ref-held cache, so it re-reads on every recordTick — the
  // quote fills in the moment the record lands (name/school line shows at once).
  const stripQuote = useMemo(() => {
    void recordTick;
    return stripPerson ? stripQuoteFrom(recordCache.current.get(stripPerson.id)) : null;
  }, [stripPerson, recordTick]);
  const showStrip = phase === "live" && lens === "why" && Boolean(stripPerson);

  // Currents: hovering or selecting someone kicks their record immediately (no
  // dwell) so the strip's verbatim quote arrives on its own, not by luck.
  const stripPersonId = stripPerson?.id ?? null;
  useEffect(() => {
    if (!needsRecordFetch(lens, stripPersonId, (id) => recordCache.current.has(id))) return;
    void loadRecord(stripPersonId as string);
  }, [lens, stripPersonId, loadRecord]);
  const subLine = LENSES.find((l) => l.key === lens)?.sub ?? "";
  const beatProgress = entering ? 1 : (beatIdx + 1) / BEAT_MS.length;

  const gradFor = (n: GNode) => {
    const pal = tokens.spectrum;
    const a = hueOf(n);
    const idx = n.motive ? motives.indexOf(n.motive) : 0;
    const b = pal[((idx < 0 ? 0 : idx) + 3) % pal.length] ?? a;
    return `linear-gradient(90deg, ${a}, ${b})`;
  };

  return (
    <div className={styles.host} ref={shellRef}>
      <canvas
        ref={canvasRef}
        className={`${styles.canvas} ${phase === "live" ? styles.canvasLive : ""}`}
        aria-label="the party graph"
      />

      {/* ---------------- Step 0: drag the CSV, watch it process ------------ */}
      {phase !== null && phase !== "live" && (
        <div className={`${styles.entry} ${entering ? styles.entryFading : ""}`}>
          <div className={styles.entryInner}>
            {phase === "entry" ? (
              <>
                <div
                  className={`${styles.dropZone} ${dragOver ? styles.dropOver : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) onFile(f);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
                  }}
                >
                  <div className={styles.dropBand} />
                  <div className={styles.dropTitle}>drop the guest list</div>
                  <div className={styles.dropSub}>
                    The room is already built. Drop the CSV it was built from and watch it assemble.
                  </div>
                  <div className={styles.dropHint}>
                    parsed in this browser · never uploaded · {graph ? `${graph.meta?.guestIds?.length ?? 0} ids on file` : "loading the room…"}
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                  }}
                />
                {entryError && (
                  <div className={styles.entryErr} role="alert">
                    {entryError.code} — {entryError.message}
                  </div>
                )}
                {loadError && !entryError && (
                  <div className={styles.entryErr} role="alert">
                    GRAPH_ARTIFACT_UNAVAILABLE — {loadError}
                  </div>
                )}
                <button type="button" className={styles.skip} onClick={goLive}>
                  skip →
                </button>
              </>
            ) : (
              <>
                {fileName && <div className={styles.fileName}>{fileName.toUpperCase()}</div>}
                <div className={styles.bar}>
                  <div className={styles.barFill} style={{ width: `${Math.round(beatProgress * 100)}%` }} />
                </div>
                {entering ? (
                  <div className={styles.entering}>Entering the room…</div>
                ) : (
                  <div className={styles.beats}>
                    {beats.map((b, i) =>
                      i <= beatIdx ? (
                        <div key={b.label} className={`${styles.beat} ${i === beatIdx ? styles.beatOn : ""}`}>
                          <span className={styles.beatLabel}>
                            {i < beatIdx ? "✓" : "·"} {b.label}
                          </span>
                          <span className={styles.beatDetail}>{b.detail}</span>
                        </div>
                      ) : null,
                    )}
                  </div>
                )}
                <button type="button" className={styles.skip} onClick={goLive}>
                  skip →
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------------- the room ---------------- */}
      {phase === "live" && (
        <>
          <div className={styles.hdr}>
            <div className={styles.hdrRow}>
              <div className={styles.brand}>
                ULTRA SUPER PARTY <span>· graph lab</span>
              </div>
              <div className={styles.cap}>
                {graph ? `${graph.meta?.people ?? graph.nodes.length} guests · real answers · every claim has a receipt` : "loading…"}
              </div>
            </div>
            <div className={styles.rain} />
            <div className={styles.tabs} role="tablist" aria-label="lenses">
              {LENSES.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  role="tab"
                  aria-selected={lens === l.key}
                  className={`${styles.tab} ${lens === l.key ? styles.tabOn : ""}`}
                  onClick={() => switchLens(l.key)}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <div className={styles.sub}>{subLine}</div>
          </div>

          <div className={styles.searchWrap}>
            <input
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="FIND YOURSELF —"
              aria-label="find a guest"
              autoComplete="off"
              spellCheck={false}
            />
            {searchHits.length > 0 && (
              <div className={styles.hits}>
                {searchHits.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={styles.hit}
                    onClick={() => {
                      select(n.id, { zoom: true });
                      setQuery("");
                    }}
                  >
                    <b className={styles.hitName}>{n.name}</b>
                    <small className={styles.hitMeta}>
                      {[n.title, n.school, n.company].filter(Boolean).join(" · ")}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </div>

          {lens === "why" && chipList.length > 0 && (
            <div className={styles.chips}>
              {chipList.map((c) => {
                const on = chip?.tag === c.tag && chip?.field === c.field;
                return (
                  <button
                    key={`${c.field}|${c.tag}`}
                    type="button"
                    className={`${styles.chip} ${on ? styles.chipOn : ""}`}
                    onClick={() => {
                      if (on) {
                        setChip(null);
                        chipRef.current = null;
                        showToast(null);
                        return;
                      }
                      setChip({ field: c.field, tag: c.tag });
                      chipRef.current = { field: c.field, tag: c.tag };
                      deselect();
                      showToast(`${c.n} PEOPLE SHARE THIS CONVICTION — ACROSS DIFFERENT CRAFTS`);
                    }}
                  >
                    <span
                      className={styles.chipDot}
                      style={{ background: tokens.spectrum[(c.i + 2) % tokens.spectrum.length] }}
                    />
                    {pretty(c.tag)} · {c.n}
                  </button>
                );
              })}
            </div>
          )}

          <div className={styles.legend}>
            <div className={styles.lrow}>
              <span className={styles.lswatch} /> shared school
            </div>
            <div className={styles.lrow}>
              <span className={`${styles.lswatch} ${styles.lswatchDash}`} /> shared company
            </div>
            <div className={styles.lrow}>
              <span className={`${styles.lswatch} ${styles.lswatchWhy}`} /> same conviction
            </div>
            <div className={styles.lrow}>
              <span className={`${styles.lswatch} ${styles.lswatchIn}`} /> looking for you
            </div>
            <div className={styles.lrow}>
              <span className={`${styles.lswatch} ${styles.lswatchOut}`} /> you&apos;re looking for
            </div>
            <div className={styles.legendNote}>tap a dot → their web · tap a row → the receipt</div>
          </div>

          {showStrip && stripPerson && (
            <div className={styles.strip}>
              <div className={styles.stripQ}>
                {stripQuote
                  ? `“${stripQuote}”`
                  : [stripPerson.mission, stripPerson.impact]
                      .filter((v): v is string => Boolean(v))
                      .map(pretty)
                      .join(" · ") || "—"}
              </div>
              <div className={styles.stripA}>
                — {stripPerson.name}
                {stripPerson.school ? ` · ${stripPerson.school}` : ""}
                {stripPerson.title ? ` · ${stripPerson.title}` : ""}
              </div>
            </div>
          )}

          {toast && <div className={styles.toast}>{toast}</div>}

          {loadError && (
            <div className={styles.center}>
              <div className={styles.centerTitle}>The graph artifact is missing</div>
              <div className={styles.centerBody}>
                {loadError} — run the emit script so /graph/graph.json exists.
              </div>
            </div>
          )}
        </>
      )}

      {/* ---------------- the person panel ---------------- */}
      <aside className={`${styles.panel} ${selNode ? styles.panelShow : ""}`} aria-label="person">
        {selNode && (
          <>
            <div className={styles.panelHead}>
              <button type="button" className={styles.pclose} onClick={deselect} aria-label="close">
                ✕
              </button>
              <div className={styles.pname}>{selNode.name}</div>
              <div className={styles.pline}>
                {[selNode.title, selNode.company ?? (selNode.free ? "independent °" : null), selNode.school]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              <div className={styles.pgrad} style={{ background: gradFor(selNode) }} />
            </div>
            <div className={styles.pbody}>
              {recordState === "missing" && (
                <div className={styles.degraded}>
                  record loading not available — /graph/people/{selNode.id}.json did not load. Showing the graph edges
                  only; verbatim quotes are withheld, not guessed.
                </div>
              )}
              {record?.storyline && <div className={styles.storyline}>{record.storyline}</div>}

              {inboundRows.length > 0 && (
                <>
                  <div className={`${styles.sec} ${styles.secFirst}`}>
                    {inboundRows.length} {inboundRows.length === 1 ? "PERSON IS" : "PEOPLE ARE"} LOOKING FOR SOMEONE
                    LIKE YOU
                  </div>
                  {inboundRows.map((r, i) => (
                    <ConnButton key={r.key} row={r} n={i + 1} other={byId.get(r.otherId)} onOpen={openReceipt} />
                  ))}
                </>
              )}

              {otherRows.length > 0 && (
                <>
                  <div className={`${styles.sec} ${inboundRows.length === 0 ? styles.secFirst : ""}`}>
                    YOUR PEOPLE TONIGHT · RANKED
                  </div>
                  {otherRows.map((r, i) => (
                    <ConnButton
                      key={r.key}
                      row={r}
                      n={inboundRows.length + i + 1}
                      other={byId.get(r.otherId)}
                      onOpen={openReceipt}
                    />
                  ))}
                </>
              )}

              {(record?.highlights?.length || fallbackFacts.length > 0) && (
                <>
                  <div className={styles.sec}>ON THE RECORD</div>
                  {record?.highlights?.length
                    ? record.highlights.map((h, i) => (
                        <div key={`${h.kind}-${i}`} className={styles.fact}>
                          {h.text}
                          {h.targets?.slice(0, 3).map((t, ti) => {
                            const target = byId.get(t);
                            return target ? (
                              <span key={t}>
                                {ti === 0 ? " " : " · "}
                                <button type="button" className={styles.factLink} onClick={() => select(t)}>
                                  {target.name}
                                </button>
                              </span>
                            ) : null;
                          })}
                        </div>
                      ))
                    : fallbackFacts.map((f) => (
                        <div key={f} className={styles.fact}>
                          {f}
                        </div>
                      ))}
                </>
              )}

              {record?.answers && (
                <>
                  <div className={styles.sec}>IN THEIR OWN WORDS</div>
                  {ANSWER_ORDER.map((f) => {
                    const v = record.answers?.[f];
                    if (!v) return null;
                    return (
                      <div key={f} className={styles.words}>
                        <span className={styles.wordsLbl}>{ANSWER_LABEL[f] ?? f.toUpperCase()}</span>
                        {v}
                      </div>
                    );
                  })}
                </>
              )}
              {recordState === "loading" && <div className={styles.degraded}>reading their record…</div>}
            </div>
          </>
        )}
      </aside>

      {/* ---------------- the receipt ---------------- */}
      {receipt && (
        <div
          className={styles.scrim}
          onClick={(e) => {
            if (e.target === e.currentTarget) setReceipt(null);
          }}
        >
          <div className={styles.receipt} role="dialog" aria-modal="true" aria-label="receipt">
            <div className={styles.rkick}>
              RECEIPT —{" "}
              <span
                className={`${styles.badge} ${
                  receipt.type === "seek"
                    ? receipt.inbound
                      ? styles.bSeekIn
                      : styles.bSeekOut
                    : TYPE_BADGE[receipt.type]
                }`}
              >
                {receipt.type.toUpperCase()}
                {receipt.mutual ? " · MUTUAL" : ""}
              </span>{" "}
              VIA “{receipt.via}”
            </div>
            <div className={styles.rcols}>
              {[receipt.left, receipt.right].map((side, i) =>
                side ? (
                  <div key={i}>
                    <div className={styles.rname}>{side.name}</div>
                    <div className={styles.rq}>{side.label}</div>
                    <div className={styles.rtxt} style={{ borderColor: side.hue }}>
                      {highlightParts(side.quote, receipt.via).map((p, j) =>
                        p.on ? <mark key={j}>{p.t}</mark> : <span key={j}>{p.t}</span>,
                      )}
                    </div>
                  </div>
                ) : null,
              )}
            </div>
            <div className={styles.rprov}>{receipt.prov}</div>
            <button type="button" className={styles.rclose} onClick={() => setReceipt(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- a via-label row */

function ConnButton({
  row,
  n,
  other,
  onOpen,
}: {
  row: ConnRow;
  n: number;
  other: GNode | undefined;
  onOpen: (row: ConnRow) => void;
}) {
  if (!other) return null;
  const badgeClass =
    row.type === "seek" ? (row.inbound ? styles.bSeekIn : styles.bSeekOut) : TYPE_BADGE[row.type];
  const via =
    row.type === "seek"
      ? `${row.mutual ? "MUTUAL · " : row.inbound ? "THEY SEEK · " : "YOU SEEK · "}${row.via}`
      : row.via;
  return (
    <button type="button" className={styles.conn} onClick={() => onOpen(row)}>
      <span className={styles.connVia}>
        <span className={styles.connN}>{String(n).padStart(2, "0")}</span>
        <span className={`${styles.badge} ${badgeClass}`}>{via.toUpperCase().slice(0, 40)}</span>
      </span>
      <div className={styles.connWho}>
        {other.name} <small>· {other.title || other.school || ""}</small>
      </div>
    </button>
  );
}
