"use client";

/**
 * GraphLab — /graph IS the Universe, re-fed with the real party data.
 *
 * One view, one grammar. Everything the Universe does on `/universe`
 * (app/universe/UniverseGraph.tsx) it does here, over `/graph/graph.json`:
 * a live `react-force-graph-2d` force room where people are flat cluster-hued
 * dots and the things they SHARE — schools, companies, crafts — are quiet
 * neutral hub dots that pull their people together. Convictions are the
 * ValueCluster stamps: tilted mono small-caps outlines that appear when you
 * lean in. Person↔person match edges (seek / why) are the SHARES_VALUE pattern —
 * far too dense for physics, so they are kept OUT of the simulation and painted
 * by hand for the selected person only.
 *
 * What is NEW here is only the data: 312 real signups, their real answers, and
 * the receipt behind every claim.
 *
 * Laws honoured:
 *  - colours come from passport/tokens.css ONLY, read with getComputedStyle
 *    (the app/universe/lib/palette.ts convention, kept local so /graph imports
 *    nothing across window boundaries). No invented hexes.
 *  - a claim without a receipt is a bug: every connection row opens the verbatim
 *    quotes from the person record, and the modal names which of the four
 *    provenance states actually happened — it never stamps "RECEIPT RESOLVED"
 *    over a record that did not load.
 *  - the dragged CSV never leaves the browser: papaparse runs client-side and
 *    the only thing we do with it is check it IS this party's guest list.
 */

import dynamic from "next/dynamic";
import Papa from "papaparse";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ForceGraphMethods, LinkObject, NodeObject } from "react-force-graph-2d";

import styles from "./graph.module.css";
import { verifyGuestList, type CsvVerdict } from "./verify";
import StampBurst, { type StampSpec } from "./StampBurst";

/* ============================================================ the contract */

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
  /** baked per-lens positions from the emitter — deliberately unused: this room
   *  is a live force layout, exactly like the Universe's. */
  pos?: Record<string, [number, number]>;
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
  canvasBg: string;
  ink: string;
  muted: string;
  faint: string;
  border: string;
  affinity: string;
  affinityInk: string;
  ringStrong: string;
  orbTint: string;
  sans: string;
  mono: string;
}

// Mirrors the shipped values in passport/tokens.css so the canvas still renders
// if the stylesheet is slow/absent (the same guarantee palette.ts makes).
const FALLBACK_TOKENS: Tokens = {
  spectrum: ["#e3aab2", "#e0a877", "#d9b96e", "#a8c18e", "#94b0d4", "#7f9fc9", "#c9b6d9", "#9fc4bb"],
  canvasBg: "#f7f6f3",
  ink: "#1b1b1f",
  muted: "#6b6b74",
  faint: "#9a9aa2",
  border: "#e7e4de",
  affinity: "#e7e5e0",
  affinityInk: "#7a7873",
  ringStrong: "rgba(27,27,31,0.55)",
  orbTint: "#c9c6ff",
  sans: "ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, Menlo, monospace",
};

function readTokens(): Tokens {
  if (typeof document === "undefined") return FALLBACK_TOKENS;
  const s = getComputedStyle(document.documentElement);
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
    canvasBg: read("--usp-canvas-bg", FALLBACK_TOKENS.canvasBg),
    ink: read("--usp-ink", FALLBACK_TOKENS.ink),
    muted: read("--usp-ink-muted", FALLBACK_TOKENS.muted),
    faint: read("--usp-ink-faint", FALLBACK_TOKENS.faint),
    border: read("--usp-border", FALLBACK_TOKENS.border),
    affinity: read("--usp-affinity", FALLBACK_TOKENS.affinity),
    affinityInk: read("--usp-affinity-ink", FALLBACK_TOKENS.affinityInk),
    ringStrong: read("--usp-ring-strong", FALLBACK_TOKENS.ringStrong),
    orbTint: read("--usp-orb-tint", FALLBACK_TOKENS.orbTint),
    sans: read("--usp-font-sans", FALLBACK_TOKENS.sans),
    mono: read("--usp-font-mono", FALLBACK_TOKENS.mono),
  };
}

/** Stable, order-independent hash so a tag always maps to the same spectrum stop. */
function hashStop(tag: string | null | undefined, spectrum: string[]): string | null {
  if (!tag) return null;
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  const pal = spectrum.length > 0 ? spectrum : FALLBACK_TOKENS.spectrum;
  return pal[h % pal.length];
}

/** Parse a hex/rgb token value into an rgba() string (for halos + hairlines). */
function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((p) => p.trim());
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return c;
}

/* ================================================================ helpers */

/**
 * Text for a round stamp's ring. The ring path is an ellipse ~320px around at
 * 20px type — roughly 34 characters before it laps itself, so the token is
 * repeated only as many times as fits and never truncated mid-word.
 */
function ring(token: string): string {
  const t = token.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const unit = `${t} · `;
  const reps = Math.max(1, Math.floor(34 / unit.length));
  return unit.repeat(reps);
}

const ANSWER_LABEL: Record<string, string> = {
  goal: "Ultimate goal",
  drew: "What drew them here",
  seeking: "Who they're looking for",
  inspiration: "Who inspires them",
  favorite: "Favorite thing",
  school: "SCHOOL",
  company: "COMPANY",
  title: "What they do",
  hometown: "Hometown",
  conviction: "Conviction",
  craft: "CRAFT",
};
const ANSWER_ORDER = ["goal", "drew", "seeking", "inspiration", "favorite"];
const labelOf = (f: string) => ANSWER_LABEL[f] ?? f.replace(/[_-]+/g, " ");
/** a verbatim answer-sheet quote is introduced by its question… */
const fieldQ = (f: string) => `Their answer · ${labelOf(f)}`;
/** …a profile cell read off the graph is introduced as a FIELD, never as a quote. */
const fieldF = (f: string) => `Profile · ${labelOf(f)}`;

const TYPE_BADGE: Record<EdgeType, string> = {
  school: styles.bSchool,
  company: styles.bCompany,
  why: styles.bWhy,
  seek: styles.bSeekOut,
};

const pretty = (s: string) => s.replace(/[_-]+/g, " ");

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highlight the matched words inside a verbatim quote — as data, so React escapes. */
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

/**
 * The footer only speaks when the columns CANNOT.
 *
 * Provenance still has to be honest (law c), but each column already carries its
 * own: "Their answer · …" over a signup quote, "Profile · …" over a profile
 * cell. Restating that underneath was telling the reader something the label
 * above already told them. So the resolved states say nothing, and the footer is
 * reserved for the one thing the labels can't express — answers we do not have.
 */
export function provenanceFor(source: ReceiptSource, _type: EdgeType, _personId: string, _oneSided = false): string {
  switch (source) {
    case "verbatim":
    case "fields":
      return "";
    case "record-loading":
      return "Loading their answers…";
    case "record-missing":
      return "Their answers didn’t load.";
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

/* ==================================================== the room (bipartite)
 * Exactly the Universe's room shape: people + the things they share, all in ONE
 * layout. A hub only exists when it actually gathers people (a school of one is
 * not a room), freelancers get no company link, and convictions are anchors that
 * never paint as dots — they paint as stamps.
 */

type RoomNodeType = "Person" | "School" | "Company" | "Craft" | "Conviction";
type RoomLinkKind = "school" | "company" | "craft" | "conviction";

interface RoomNode {
  id: string;
  type: RoomNodeType;
  label: string;
  /** the Universe's line2, on the canvas: a person's craft (· class year when the
   *  data ever carries one — graph.json has no year field today). */
  sub?: string;
  /** person: their motive hue · conviction: the tag's hue · hub: null (neutral) */
  hue: string | null;
  /** person: their edge degree · hub/conviction: how many people it holds */
  weight: number;
  memberIds?: string[];
  x?: number;
  y?: number;
}

interface RoomLink {
  source: string | RoomNode;
  target: string | RoomNode;
  kind: RoomLinkKind;
}

interface Room {
  nodes: RoomNode[];
  links: RoomLink[];
  byId: Map<string, RoomNode>;
  /** node id → the ids it is linked to in the layout (the ego web) */
  adjacency: Map<string, string[]>;
  counts: { schools: number; companies: number; crafts: number; convictions: number };
}

const MIN_SCHOOL = 2;
const MIN_COMPANY = 2;
const MIN_CRAFT = 4;
const MIN_CONVICTION = 3;

function groupPeople(
  people: GNode[],
  pick: (n: GNode) => string | null | undefined,
  min: number,
): [string, GNode[]][] {
  const m = new Map<string, GNode[]>();
  for (const n of people) {
    const raw = pick(n);
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) continue;
    const list = m.get(v);
    if (list) list.push(n);
    else m.set(v, [n]);
  }
  return [...m.entries()].filter(([, list]) => list.length >= min).sort((a, b) => b[1].length - a[1].length);
}

function buildRoom(graph: Graph, spectrum: string[]): Room {
  const nodes: RoomNode[] = [];
  const links: RoomLink[] = [];
  const adjacency = new Map<string, string[]>();

  for (const p of graph.nodes) {
    nodes.push({
      id: p.id,
      type: "Person",
      label: p.name,
      sub: p.asp ? pretty(p.asp) : undefined,
      hue: hashStop(p.motive, spectrum),
      weight: p.deg,
    });
    adjacency.set(p.id, []);
  }

  const addHub = (
    id: string,
    type: RoomNodeType,
    label: string,
    hue: string | null,
    members: GNode[],
    kind: RoomLinkKind,
  ) => {
    nodes.push({ id, type, label, hue, weight: members.length, memberIds: members.map((m) => m.id) });
    adjacency.set(id, []);
    for (const m of members) {
      links.push({ source: m.id, target: id, kind });
      adjacency.get(m.id)?.push(id);
      adjacency.get(id)?.push(m.id);
    }
  };

  const schools = groupPeople(graph.nodes, (n) => n.school, MIN_SCHOOL);
  for (const [name, members] of schools) addHub(`school:${name}`, "School", name, null, members, "school");

  // freelancers get no company link — "independent" is not a room you share
  const companies = groupPeople(graph.nodes, (n) => (n.free ? null : n.company), MIN_COMPANY);
  for (const [name, members] of companies) addHub(`company:${name}`, "Company", name, null, members, "company");

  const crafts = groupPeople(graph.nodes, (n) => n.asp, MIN_CRAFT);
  for (const [asp, members] of crafts) addHub(`craft:${asp}`, "Craft", pretty(asp), null, members, "craft");

  // convictions: anchors in the layout (weak pull, like the Universe's IN_CLUSTER),
  // painted as stamps rather than dots.
  let convictions = 0;
  for (const field of ["mission", "impact"] as const) {
    for (const [tag, members] of groupPeople(graph.nodes, (n) => n[field], MIN_CONVICTION)) {
      addHub(`conviction:${field}:${tag}`, "Conviction", pretty(tag), hashStop(tag, spectrum), members, "conviction");
      convictions += 1;
    }
  }

  return {
    nodes,
    links,
    byId: new Map(nodes.map((n) => [n.id, n])),
    adjacency,
    counts: { schools: schools.length, companies: companies.length, crafts: crafts.length, convictions },
  };
}

/* ================================================= the canvas (force room) */

type FGNode = NodeObject<RoomNode>;
type FGLink = LinkObject<RoomNode, RoomLink>;

interface FGProps {
  ref?: React.Ref<ForceGraphMethods<RoomNode, RoomLink> | undefined>;
  graphData: { nodes: FGNode[]; links: FGLink[] };
  width?: number;
  height?: number;
  backgroundColor?: string;
  nodeRelSize?: number;
  nodeLabel?: (node: FGNode) => string;
  nodeCanvasObject?: (node: FGNode, ctx: CanvasRenderingContext2D, scale: number) => void;
  nodePointerAreaPaint?: (node: FGNode, color: string, ctx: CanvasRenderingContext2D, scale: number) => void;
  linkColor?: (link: FGLink) => string;
  linkWidth?: (link: FGLink) => number;
  linkLineDash?: (link: FGLink) => number[] | null;
  onNodeClick?: (node: FGNode) => void;
  onBackgroundClick?: () => void;
  onRenderFramePre?: (ctx: CanvasRenderingContext2D, scale: number) => void;
  onRenderFramePost?: (ctx: CanvasRenderingContext2D, scale: number) => void;
  onEngineStop?: () => void;
  autoPauseRedraw?: boolean;
  d3VelocityDecay?: number;
  minZoom?: number;
  maxZoom?: number;
  enableNodeDrag?: boolean;
}

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
}) as unknown as React.ComponentType<FGProps>;

// Force tuning, straight from the Universe: hub spokes stay short (the fine web);
// conviction ties are longer and weak so the clouds read as tendencies, not silos.
const LINK_DISTANCE: Record<RoomLinkKind, number> = {
  school: 28,
  company: 28,
  craft: 32,
  conviction: 40,
};
const CONVICTION_STRENGTH = 0.15;
const CHARGE_STRENGTH = -28;
/** convictions name themselves only once you lean in (progressive disclosure) */
const STAMP_ZOOM = 1.15;

interface CanvasProps {
  room: Room;
  /** person↔person seek/why edges of the selected person — painted, never simulated */
  matchEdges: GEdge[];
  selectedId: string | null;
  /** a search hit asks the camera to fly; the nonce lets the same person re-focus */
  focusReq: { id: string; n: number } | null;
  matchedIds: Set<string> | null;
  tokens: Tokens;
  onSelect: (node: RoomNode | null) => void;
}

function GraphRoom({ room, matchEdges, selectedId, focusReq, matchedIds, tokens, onSelect }: CanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods<RoomNode, RoomLink> | undefined>(undefined);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Stable copy: force-graph mutates x/y/source/target in place and must not
  // corrupt the room the panel reads from.
  const graphData = useMemo(
    () => ({
      nodes: room.nodes.map((n) => ({ ...n })) as FGNode[],
      links: room.links.map((l) => ({ ...l })) as FGLink[],
    }),
    [room],
  );

  const simById = useMemo(() => new Map(graphData.nodes.map((n) => [String(n.id), n])), [graphData]);
  const stampNodes = useMemo(() => graphData.nodes.filter((n) => n.type === "Conviction"), [graphData]);

  // top people by degree — the only names shown at mid-zoom (progressive disclosure)
  const labelElect = useMemo(
    () =>
      new Set(
        room.nodes
          .filter((n) => n.type === "Person")
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 24)
          .map((n) => n.id),
      ),
    [room],
  );

  // container measurement
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- force tuning ----
  // ForceGraph2D is dynamically imported and only mounts once the host is
  // measured, so fgRef.current is not there on the first effect run — retry on
  // rAF until it is, then shape the layout and reheat.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;

    const endId = (e: FGLink["source"]): string => String(typeof e === "object" && e !== null ? (e as FGNode).id : e);
    const degree = new Map<string, number>();
    for (const l of graphData.links) {
      for (const k of [endId(l.source), endId(l.target)]) degree.set(k, (degree.get(k) ?? 0) + 1);
    }

    const tune = () => {
      if (cancelled) return;
      const fg = fgRef.current;
      if (!fg) {
        raf = requestAnimationFrame(tune);
        return;
      }
      const linkForce = fg.d3Force("link");
      if (linkForce) {
        linkForce.distance((l: FGLink) => LINK_DISTANCE[l.kind] ?? 30);
        linkForce.strength((l: FGLink) => {
          if (l.kind === "conviction") return CONVICTION_STRENGTH;
          // d3's default heuristic — hubs with many spokes pull each spoke less,
          // which is what keeps the attribute mesh fine and organic.
          const s = degree.get(endId(l.source)) ?? 1;
          const t = degree.get(endId(l.target)) ?? 1;
          return 1 / Math.min(s, t);
        });
      }
      const charge = fg.d3Force("charge");
      if (charge) charge.strength(CHARGE_STRENGTH);
      fg.d3ReheatSimulation();
    };

    tune();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [graphData]);

  // fly to a searched name
  useEffect(() => {
    if (!focusReq) return;
    const fg = fgRef.current;
    const n = simById.get(focusReq.id);
    if (!fg || !n || typeof n.x !== "number" || typeof n.y !== "number") return;
    fg.centerAt(n.x, n.y, 700);
    fg.zoom(2.4, 700);
  }, [focusReq, simById]);

  // the lit set: the selected node, its hubs, and (for a person) their match-mates
  const egoSet = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId, ...(room.adjacency.get(selectedId) ?? [])]);
    for (const e of matchEdges) set.add(e.s === selectedId ? e.t : e.s);
    return set;
  }, [selectedId, room, matchEdges]);

  const radiusOf = useCallback((n: FGNode): number => {
    if (n.type === "Person") return 5;
    return Math.min(2.8 + Math.sqrt(Math.max(n.weight, 1)) * 1.15, 16);
  }, []);

  // ---- the selected person's match web + halo (painted, never simulated) ----
  const onRenderFramePre = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!selectedId) return;
      const sel = simById.get(selectedId);
      if (!sel || typeof sel.x !== "number" || typeof sel.y !== "number") return;
      const spec = tokens.spectrum;
      ctx.save();
      for (const e of matchEdges) {
        const otherId = e.s === selectedId ? e.t : e.s;
        const other = simById.get(otherId);
        if (!other || typeof other.x !== "number" || typeof other.y !== "number") continue;
        const inbound = e.type === "seek" && e.t === selectedId;
        const hue =
          e.type === "why"
            ? spec[6] ?? tokens.ink
            : inbound
              ? spec[1] ?? tokens.ink // warm: someone is looking for THEM
              : spec[5] ?? tokens.ink; // cool: they are the one looking
        ctx.strokeStyle = withAlpha(hue, e.type === "why" ? 0.55 : 0.8);
        ctx.lineWidth = e.m ? 1.8 : e.type === "why" ? 0.8 : 1.1;
        ctx.beginPath();
        ctx.moveTo(sel.x, sel.y);
        if (e.type === "seek") {
          // a slight arc, so inbound and outbound never sit on top of each other
          const mx = (sel.x + other.x) / 2 + (other.y - sel.y) * 0.12;
          const my = (sel.y + other.y) / 2 - (other.x - sel.x) * 0.12;
          ctx.quadraticCurveTo(mx, my, other.x, other.y);
        } else {
          ctx.lineTo(other.x, other.y);
        }
        ctx.stroke();
      }
      const R = 16;
      const g = ctx.createRadialGradient(sel.x, sel.y, 0, sel.x, sel.y, R);
      g.addColorStop(0, withAlpha(tokens.ringStrong, 0.35));
      g.addColorStop(1, withAlpha(tokens.ringStrong, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sel.x, sel.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
    [matchEdges, selectedId, simById, tokens],
  );

  // ---- node painting ----
  const nodeCanvasObject = useCallback(
    (node: FGNode, ctx: CanvasRenderingContext2D, scale: number) => {
      if (node.type === "Conviction") return; // stamps are painted after the frame
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = radiusOf(node);
      const selected = node.id === selectedId;
      const dimmed = egoSet ? !egoSet.has(String(node.id)) : false;
      ctx.globalAlpha = dimmed ? 0.12 : 1;

      if (node.type === "Person") {
        // colour IS the relationship mapping: a person wears their creative
        // motive as a flat, confident fill — no glow, just ink-ringed colour.
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(node.hue ?? tokens.orbTint, selected ? 1 : 0.88);
        ctx.fill();
        ctx.lineWidth = selected ? 1.4 : 0.6;
        ctx.strokeStyle = selected ? tokens.ringStrong : withAlpha(tokens.ink, 0.35);
        ctx.stroke();
      } else {
        // school / company / craft: quiet neutral anchors
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(tokens.affinity, 0.9);
        ctx.fill();
        ctx.lineWidth = selected ? 1.2 : 0.4;
        ctx.strokeStyle = selected ? tokens.ringStrong : withAlpha(tokens.affinityInk, 0.4);
        ctx.stroke();
        // the number the size speaks for
        if (node.weight >= 4 && r >= 6.5) {
          ctx.font = `600 ${Math.max(r * 0.9, 5)}px ${tokens.sans}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = withAlpha(tokens.ink, 0.75);
          ctx.fillText(String(node.weight), x, y);
        }
      }

      const matched = (matchedIds?.has(String(node.id)) ?? false) || (selected && node.type === "Person");
      const showLabel =
        selected ||
        (node.type === "Person" && ((scale > 0.95 && labelElect.has(String(node.id))) || scale > 1.35)) ||
        (node.type !== "Person" && scale > 1.7);
      if (!showLabel && !matched) {
        ctx.globalAlpha = 1;
        return;
      }

      // the found-you moment reads from across the room: matched names render
      // ~2.2x, ride a slow wave, and the dot wears a breathing ring.
      const fontPx = (matched ? 22 : node.type === "Person" ? 10 : 8) / scale;
      ctx.font = `${matched ? 700 : 420} ${fontPx}px ${tokens.sans}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const labelY = y + r + 1.5 / scale;
      ctx.lineJoin = "round";
      ctx.lineWidth = (matched ? 5 : 3) / scale;
      ctx.strokeStyle = withAlpha(tokens.canvasBg, selected || matched ? 0.95 : 0.7);
      if (matched) {
        const pulse = 1 + Math.sin(performance.now() / 300) * 0.25;
        ctx.beginPath();
        ctx.arc(x, y, r + 4 * pulse, 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(tokens.spectrum[3] ?? tokens.ink, 0.65);
        ctx.lineWidth = 1.6 / scale;
        ctx.stroke();
        ctx.strokeStyle = withAlpha(tokens.canvasBg, 0.95);
        ctx.lineWidth = 5 / scale;
        // each letter rides the wave, the spectrum blended across the whole name
        const t = performance.now();
        const letters = (node.label ?? "").split("");
        const widths = letters.map((ch) => ctx.measureText(ch).width);
        const total = widths.reduce((a, b) => a + b, 0);
        const grad = ctx.createLinearGradient(x - total / 2, 0, x + total / 2, 0);
        const spec = tokens.spectrum;
        const stops = [spec[0], spec[3], spec[4], spec[5] ?? spec[0]].filter(Boolean);
        stops.forEach((c, si) => grad.addColorStop(si / Math.max(1, stops.length - 1), c));
        ctx.textAlign = "left";
        let cx = x - total / 2;
        letters.forEach((ch, li) => {
          const dy = Math.sin(t / 260 + li * 0.6) * (3.4 / scale);
          ctx.strokeText(ch, cx, labelY + dy);
          ctx.fillStyle = grad;
          ctx.fillText(ch, cx, labelY + dy);
          cx += widths[li];
        });
        ctx.textAlign = "center";
      } else {
        ctx.strokeText(node.label, x, labelY);
        ctx.fillStyle = node.type === "Person" ? tokens.ink : tokens.affinityInk;
        ctx.fillText(node.label, x, labelY);
      }
      // the line2 pattern: a person's craft rides under their name whenever the
      // name shows — same threshold, one tier quieter (the hub-label size/ink).
      if (node.type === "Person" && node.sub) {
        const subPx = 8 / scale;
        ctx.font = `420 ${subPx}px ${tokens.sans}`;
        ctx.textAlign = "center";
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = withAlpha(tokens.canvasBg, 0.85);
        const subY = labelY + fontPx + 1.5 / scale;
        ctx.strokeText(node.sub, x, subY);
        ctx.fillStyle = tokens.affinityInk;
        ctx.fillText(node.sub, x, subY);
      }
      ctx.globalAlpha = 1;
    },
    [egoSet, labelElect, matchedIds, radiusOf, selectedId, tokens],
  );

  // ---- conviction stamps: tilted mono small-caps outlines at the anchors ----
  const onRenderFramePost = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      if (scale <= STAMP_ZOOM) return;
      const fontPx = 10 / scale;
      ctx.save();
      ctx.font = `600 ${fontPx}px ${tokens.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const s of stampNodes) {
        if (typeof s.x !== "number" || typeof s.y !== "number") continue;
        const dimmed = egoSet ? !egoSet.has(String(s.id)) : false;
        ctx.globalAlpha = dimmed ? 0.16 : 0.9;
        const text = `${s.label} · ${s.weight}`;
        const w = ctx.measureText(text).width;
        const padX = 6 / scale;
        const padY = 4 / scale;
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(-0.052);
        ctx.fillStyle = withAlpha(tokens.canvasBg, 0.72);
        ctx.beginPath();
        ctx.roundRect(-w / 2 - padX, -fontPx / 2 - padY, w + padX * 2, fontPx + padY * 2, 4 / scale);
        ctx.fill();
        ctx.strokeStyle = withAlpha(s.hue ?? tokens.ink, 0.75);
        ctx.lineWidth = 1 / scale;
        ctx.stroke();
        ctx.fillStyle = withAlpha(tokens.ink, 0.8);
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    },
    [egoSet, stampNodes, tokens],
  );

  const nodePointerAreaPaint = useCallback(
    (node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
      if (node.type === "Conviction") return; // stamps are scenery, not targets
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, radiusOf(node) + 1.5, 0, Math.PI * 2);
      ctx.fill();
    },
    [radiusOf],
  );

  const isSelectedEnd = useCallback(
    (link: FGLink) => {
      if (!selectedId) return false;
      const a = link.source as FGNode | string;
      const b = link.target as FGNode | string;
      return (
        String(typeof a === "object" ? a.id : a) === selectedId ||
        String(typeof b === "object" ? b.id : b) === selectedId
      );
    },
    [selectedId],
  );

  const linkColor = useCallback(
    (link: FGLink) => {
      const lit = isSelectedEnd(link);
      if (!lit && egoSet) return withAlpha(tokens.ink, 0.03); // someone selected: the rest is paper
      if (!lit) return withAlpha(tokens.ink, link.kind === "conviction" ? 0.04 : 0.08);
      const spec = tokens.spectrum;
      switch (link.kind) {
        case "school":
          return withAlpha(spec[3] ?? tokens.ink, 0.85);
        case "company":
          return withAlpha(spec[0] ?? tokens.ink, 0.85);
        case "craft":
          return withAlpha(spec[4] ?? tokens.ink, 0.85);
        default:
          return withAlpha(spec[6] ?? tokens.ink, 0.6);
      }
    },
    [egoSet, isSelectedEnd, tokens],
  );

  const linkWidth = useCallback((link: FGLink) => (isSelectedEnd(link) ? 1.6 : 0.5), [isSelectedEnd]);
  const linkLineDash = useCallback(
    (link: FGLink) => (link.kind === "conviction" ? [2, 3] : link.kind === "company" ? [3, 4] : null),
    [],
  );

  const handleNodeClick = useCallback((node: FGNode) => onSelect(node as RoomNode), [onSelect]);
  const handleBgClick = useCallback(() => onSelect(null), [onSelect]);
  const onEngineStop = useCallback(() => {
    fgRef.current?.zoomToFit?.(500, 70);
  }, []);

  return (
    <div ref={hostRef} className={styles.canvasHost}>
      {size.w > 0 && size.h > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          backgroundColor={tokens.canvasBg}
          graphData={graphData}
          nodeRelSize={5}
          nodeLabel={(n) => n.label}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={nodePointerAreaPaint}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={linkLineDash}
          onNodeClick={handleNodeClick}
          onBackgroundClick={handleBgClick}
          onRenderFramePre={onRenderFramePre}
          onRenderFramePost={onRenderFramePost}
          onEngineStop={onEngineStop}
          autoPauseRedraw={false}
          d3VelocityDecay={0.32}
          minZoom={0.4}
          maxZoom={12}
          enableNodeDrag
        />
      )}
    </div>
  );
}

/* --------------------------------------------- Step 0: CSV verification */

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* ---- data ---- */
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const graphRef = useRef<Graph | null>(null);

  /* ---- entry theatre ---- */
  const [phase, setPhase] = useState<Phase | null>(null); // null until we know
  /** 0 = the party's name, 1 = the mark, 2 = dissolving into the room */
  const [entryBeat, setEntryBeat] = useState(0);
  /** the ranked list is a long tail — three rows, then on request */
  const [showAllConns, setShowAllConns] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<{ code: string; message: string } | null>(null);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [beatIdx, setBeatIdx] = useState(-1);
  const [entering, setEntering] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /* ---- room state ---- */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selRef = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);
  const [record, setRecord] = useState<PersonRecord | null>(null);
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordCache = useRef<Map<string, PersonRecord | null>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());

  /* ---- Teri's tokens, read once (client-only component: safe at init) ---- */
  const [tokens] = useState<Tokens>(() => readTokens());

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

  const room = useMemo(() => (graph ? buildRoom(graph, tokens.spectrum) : null), [graph, tokens]);

  const hueOf = useCallback(
    (n: GNode | null | undefined): string => hashStop(n?.motive, tokens.spectrum) ?? tokens.orbTint,
    [tokens],
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

  const selNode = selectedId ? byId.get(selectedId) ?? null : null;
  const selHub = selectedId && !selNode ? room?.byId.get(selectedId) ?? null : null;

  /** the selected person's person↔person match edges: painted, never simulated */
  const matchEdges = useMemo(() => {
    if (!graph || !selNode || !selectedId) return [] as GEdge[];
    return graph.edges.filter(
      (e) => (e.type === "seek" || e.type === "why") && (e.s === selectedId || e.t === selectedId),
    );
  }, [graph, selNode, selectedId]);

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

  const matchedIds = useMemo(
    () => (searchHits.length > 0 ? new Set(searchHits.map((h) => h.id)) : null),
    [searchHits],
  );

  /* -------------------------------------------------------- data + entry */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/graph/graph.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`graph.json → HTTP ${res.status}`);
        const data = (await res.json()) as Graph;
        if (cancelled) return;
        if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
          throw new Error("graph.json is missing nodes/edges");
        }
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

  // The entry is a title card, not a task. It names the party, shows the mark,
  // and hands over to the room that is already built — no CSV, no decision. A
  // deep link or a return visit skips it entirely.
  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem("usp-graph-seen") === "1";
    } catch {
      seen = false;
    }
    const deepLink = typeof location !== "undefined" && location.hash.length > 1;
    if (deepLink || seen) {
      setPhase("live");
      return;
    }
    setPhase("entry");
    const t = timersRef.current;
    // title → mark → room
    t.push(setTimeout(() => setEntryBeat(1), 1500));
    t.push(setTimeout(() => setEntryBeat(2), 3000));
    t.push(
      setTimeout(() => {
        try {
          sessionStorage.setItem("usp-graph-seen", "1");
        } catch {
          /* private mode — the title card simply plays again next visit */
        }
        setPhase("live");
      }, 3900),
    );
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      if (toastTimer.current) clearTimeout(toastTimer.current);
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
    if (inFlightRef.current.has(id)) return;
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
    }
  }, []);

  const selectPerson = useCallback(
    (id: string) => {
      if (!graphRef.current) return;
      if (!graphRef.current.nodes.some((n) => n.id === id)) {
        // fail loud, never silently: a deep link to nobody says so
        showToast(`NO GUEST “${id}” IN THIS GRAPH`);
        return;
      }
      selRef.current = id;
      setSelectedId(id);
      const cached = recordCache.current.get(id);
      setRecord(cached ?? null);
      setRecordState(cached ? "ok" : "idle");
      void loadRecord(id);
      try {
        history.replaceState(null, "", `#${id}`);
      } catch {
        /* non-fatal */
      }
    },
    [loadRecord, showToast],
  );

  const deselect = useCallback(() => {
    selRef.current = null;
    setSelectedId(null);
    setRecord(null);
    setRecordState("idle");
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* non-fatal */
    }
  }, []);

  const onSelectNode = useCallback(
    (node: RoomNode | null) => {
      if (!node) {
        deselect();
        return;
      }
      if (node.type === "Person") {
        selectPerson(node.id);
        return;
      }
      // a hub: the room itself, and everyone standing in it
      selRef.current = null;
      setSelectedId(node.id);
      setRecord(null);
      setRecordState("idle");
    },
    [deselect, selectPerson],
  );

  // hash deep links (initial + back/forward)
  useEffect(() => {
    if (!graph) return;
    const fromHash = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id) selectPerson(id);
    };
    fromHash();
    const onHash = () => fromHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [graph, selectPerson]);

  useEffect(() => {
    if (phase !== "live" || !graph) return;
    showToast(`Tap a dot to see who’s looking for them`);
  }, [phase, graph, showToast]);

  /* --------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (receipt) setReceipt(null);
      else deselect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deselect, receipt]);

  /* ------------------------------------------------- connection rows */

  /** The fallback ranking when the person record is unavailable — the same
   *  ordering the emit script bakes into the record. */
  const rowsFromGraph = useCallback(
    (id: string): ConnRow[] => {
      const list = (adjacency.get(id) ?? []).map((e) => {
        const other = e.s === id ? e.t : e.s;
        const inbound = e.type === "seek" && e.t === id;
        const w =
          e.type === "seek" ? (e.m ? 100 : inbound ? 90 : 80) : e.type === "why" ? 60 : e.type === "company" ? 40 : 30;
        return { e, other, inbound, w };
      });
      const seen = new Set<string>();
      const out: ConnRow[] = [];
      for (const r of list.sort((a, b) => b.w - a.w)) {
        const k = `${r.other}|${r.e.type}|${r.inbound}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ key: k, otherId: r.other, type: r.e.type, via: r.e.via, inbound: r.inbound, mutual: Boolean(r.e.m) });
      }
      return out;
    },
    [adjacency],
  );

  const rows: ConnRow[] = useMemo(() => {
    if (!selNode) return [];
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
    return rowsFromGraph(selNode.id);
  }, [selNode, record, recordState, rowsFromGraph]);

  const inboundRows = rows.filter((r) => r.type === "seek" && r.inbound);
  const otherRows = rows.filter((r) => !(r.type === "seek" && r.inbound)).slice(0, 12);

  const openReceipt = useCallback(
    (row: ConnRow) => {
      const self = selNode;
      const other = byId.get(row.otherId) ?? null;
      if (!self || !other) return;
      const yours = row.receipt?.yours?.quote ? row.receipt.yours : undefined;
      const theirs = row.receipt?.theirs?.quote ? row.receipt.theirs : undefined;
      const source = receiptSource(Boolean(yours), Boolean(theirs), recordState);
      // each column names its OWN provenance: a verbatim answer or a profile cell
      const sideOf = (node: GNode, quoted: ReceiptSide | undefined): ReceiptSideView | null => {
        if (quoted) return { name: node.name, hue: hueOf(node), label: fieldQ(quoted.field), quote: quoted.quote };
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
        prov: provenanceFor(source, row.type, self.id, Boolean(yours) !== Boolean(theirs)),
      });
    },
    [byId, hueOf, recordState, selNode],
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

  /**
   * The panel's facts, as stamp windows.
   *
   * Three artifacts carry every kind of fact — the art is a WINDOW, not a
   * meaning. A cohort count ("one of 28 aiming to design") is a round stamp; a
   * fact that names another guest is a nametag, because a nametag is what you
   * read off a person; a quote is the belief card, because that is the one with
   * a typewriter slot that wraps.
   *
   * Order matters: identity first, then the room's verdict on them.
   */
  const stampSpecs = useMemo<StampSpec[]>(() => {
    if (!selNode) return [];
    const out: StampSpec[] = [];
    const first = selNode.name.split(/\s+/)[0] ?? selNode.name;
    const ans = record?.answers ?? {};

    // 1 — the day job
    const org = [selNode.company, selNode.school].filter(Boolean).join(" · ");
    if (selNode.title || org) {
      out.push({
        id: "dayjob",
        asset: "nametag",
        rot: -8,
        values: { headerLabel: "The day job", org, name: selNode.title || "creative" },
      });
    }

    // 2 — where they came from, as a rubber stamp.
    // The ring runs an ellipse ~320px long at 20px type: anything past a few
    // short words laps itself and turns to mud. Keep ring tokens tiny.
    if (ans.hometown) {
      out.push({
        id: "hometown",
        asset: "roundStamp",
        rot: 3,
        values: {
          relation: ans.hometown,
          ringText: ring(first),
          name: "came from",
        },
      });
    }

    // 3+ — the room's verdict: cohort counts, and who it points you at.
    //
    // The belief card carries "you both believe" as OUTLINED ART, not a slot
    // (pepl added a CHANGE_small there; our asset predates it). So it may only
    // carry a fact where that sentence is literally true — one that names
    // another guest you share an answer with. A cohort count in that frame
    // would be a false claim, so counts get the rubber stamp instead.
    const facts = record?.highlights?.length
      ? record.highlights.map((h) => ({ text: h.text, targets: h.targets ?? [] }))
      : fallbackFacts.map((t) => ({ text: t, targets: [] as string[] }));

    facts.slice(0, 4).forEach((f, i) => {
      const named = f.targets.map((t) => byId.get(t)?.name).filter(Boolean)[0];
      out.push(
        named
          ? {
              id: `fact-${i}`,
              asset: "beliefStamp",
              rot: i % 2 ? -5 : 7,
              values: { belief: f.text, name: String(named).toLowerCase() },
            }
          : {
              id: `fact-${i}`,
              asset: "roundStamp",
              rot: i % 2 ? 7 : -3,
              values: { relation: f.text, ringText: ring("in the room"), name: "tonight" },
            },
      );
    });

    return out;
  }, [selNode, record, fallbackFacts, byId]);

  /* ---------------------------------------------------------------- view */

  const counts = room?.counts;
  const hubKicker = selHub?.type === "School" ? "Studies at" : selHub?.type === "Company" ? "Works at" : "Craft";
  const beatProgress = entering ? 1 : (beatIdx + 1) / BEAT_MS.length;

  return (
    <div className={styles.host}>
      <div className={`${styles.canvasFade} ${phase === "live" ? styles.canvasLive : ""}`}>
        {room && (
          <GraphRoom
            room={room}
            matchEdges={matchEdges}
            selectedId={selectedId}
            focusReq={focusReq}
            matchedIds={matchedIds}
            tokens={tokens}
            onSelect={onSelectNode}
          />
        )}
      </div>

      {/* ------------- the title card: name the party, show the mark ------- */}
      {phase !== null && phase !== "live" && (
        <div className={`${styles.entry} ${entryBeat >= 2 ? styles.entryFading : ""}`}>
          <div className={styles.titleCard}>
            <div className={`${styles.cardLine} ${entryBeat === 0 ? styles.cardOn : styles.cardOff}`}>
              <span className={styles.partyName}>LA Intern Party</span>
            </div>
            <div className={`${styles.cardLine} ${entryBeat === 1 ? styles.cardOn : styles.cardOff}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.svg" alt="2C" className={styles.mark} width={92} height={92} />
            </div>
          </div>
          <button type="button" className={styles.skip} onClick={goLive}>
            skip →
          </button>
        </div>
      )}

      {phase === "live" && (
        <>
          <header className={styles.header}>
            <div className={styles.titleWrap}>
              <h1 className={styles.title}>The Party Graph</h1>
              {counts && graph && (
                <p className={styles.subtitle}>
                  {graph.meta?.people ?? graph.nodes.length} people · {counts.schools} schools · {counts.companies}{" "}
                  companies · {counts.crafts} crafts
                </p>
              )}
            </div>
            <span className={styles.banner}>
              <span className={styles.dot} /> Real signups
            </span>
          </header>

          <div className={styles.searchWrap}>
            <input
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="what’s your name?"
              aria-label="find a guest"
              autoComplete="off"
              spellCheck={false}
            />
            {searchHits.map((n) => (
              <button
                key={n.id}
                type="button"
                className={styles.hit}
                onClick={() => {
                  selectPerson(n.id);
                  setFocusReq({ id: n.id, n: Date.now() });
                  setQuery("");
                }}
              >
                <span className={styles.hitName}>{n.name}</span>
                <span className={styles.hitMeta}>find yourself →</span>
              </button>
            ))}
          </div>

          {room && (
            <div className={styles.legend}>
              <div className={styles.legendRow}>
                <span className={styles.legendSwatch} /> Schools · companies · crafts
              </div>
              <div className={styles.legendRow}>
                <span className={`${styles.legendLine} ${styles.lineSchool}`} /> Same school
              </div>
              <div className={styles.legendRow}>
                <span className={`${styles.legendLine} ${styles.lineCompany}`} /> Same company
              </div>
              <div className={styles.legendRow}>
                <span className={styles.legendStamp} /> Conviction stamps
              </div>
              <div className={styles.legendRow}>
                <span className={`${styles.legendLine} ${styles.lineIn}`} /> Looking for them
              </div>
              <div className={styles.legendRow}>
                <span className={`${styles.legendLine} ${styles.lineOut}`} /> They’re looking for
              </div>
              <div className={styles.legendRow}>
                <span className={`${styles.legendLine} ${styles.lineWhy}`} /> Same conviction
              </div>
            </div>
          )}

          {toast && <div className={styles.toast}>{toast}</div>}

          {loadError && (
            <div className={styles.center}>
              <div className={styles.centerTitle}>The graph artifact is missing</div>
              <div className={styles.centerBody}>{loadError} — run the emit script so /graph/graph.json exists.</div>
            </div>
          )}

          {!graph && !loadError && (
            <div className={styles.center}>
              <div className={styles.spinner} />
              <div className={styles.centerBody}>Assembling the room…</div>
            </div>
          )}
        </>
      )}

      {/* ---------------- the person / hub panel ---------------- */}
      <aside className={`${styles.panel} ${selNode || selHub ? styles.panelShow : ""}`} aria-label="person">
        {selNode && (
          <>
            <div className={styles.panelHead}>
              <button type="button" className={styles.pclose} onClick={deselect} aria-label="close">
                ✕
              </button>
              <div className={styles.pkicker}>
                <span className={styles.pswatch} style={{ background: hueOf(selNode) }} />
                {selNode.motive ? pretty(selNode.motive) : "Person"}
              </div>
              <div className={styles.pname}>{selNode.name}</div>
              <div className={styles.pline}>
                {[
                  selNode.asp ? pretty(selNode.asp) : null,
                  selNode.title,
                  selNode.company ?? (selNode.free ? "independent °" : null),
                  selNode.school,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            <div className={styles.pbody}>
              {recordState === "missing" && (
                <div className={styles.degraded}>
                  Their answers didn’t load.
                </div>
              )}
              {record?.storyline && <div className={styles.storyline}>{record.storyline}</div>}

              {stampSpecs.length > 0 && (
                <>
                  <div className={styles.sec}>On the record</div>
                  <StampBurst specs={stampSpecs} on />
                  {/* the targets a stamp names stay clickable underneath it */}
                  {record?.highlights
                    ?.flatMap((h) => h.targets ?? [])
                    .slice(0, 4)
                    .map((t) => {
                      const target = byId.get(t);
                      return target ? (
                        <button
                          key={t}
                          type="button"
                          className={styles.factLink}
                          onClick={() => selectPerson(t)}
                        >
                          {target.name}
                        </button>
                      ) : null;
                    })}
                </>
              )}

              {inboundRows.length > 0 && (
                <>
                  <div className={`${styles.sec} ${styles.secFirst}`}>
                    {inboundRows.length} {inboundRows.length === 1 ? "person is" : "people are"} looking for someone
                    like you
                  </div>
                  {inboundRows.map((r, i) => (
                    <ConnButton key={r.key} row={r} n={i + 1} other={byId.get(r.otherId)} onOpen={openReceipt} />
                  ))}
                </>
              )}

              {otherRows.length > 0 && (
                <>
                  <div className={styles.sec}>Your people tonight</div>
                  {(showAllConns ? otherRows : otherRows.slice(0, 3)).map((r, i) => (
                    <ConnButton
                      key={r.key}
                      row={r}
                      n={inboundRows.length + i + 1}
                      other={byId.get(r.otherId)}
                      onOpen={openReceipt}
                    />
                  ))}
                  {otherRows.length > 3 && (
                    <button
                      type="button"
                      className={styles.moreConns}
                      onClick={() => setShowAllConns((v: boolean) => !v)}
                    >
                      {showAllConns ? "show fewer" : `show ${otherRows.length - 3} more`}
                    </button>
                  )}
                </>
              )}

              {record?.answers && (
                <>
                  <div className={styles.sec}>In their own words</div>
                  {ANSWER_ORDER.map((f) => {
                    const v = record.answers?.[f];
                    if (!v) return null;
                    return (
                      <div key={f} className={styles.words}>
                        <span className={styles.wordsLbl}>{ANSWER_LABEL[f] ?? f}</span>
                        {v}
                      </div>
                    );
                  })}
                </>
              )}
              {recordState === "loading" && <div className={styles.degraded}>loading…</div>}
            </div>
          </>
        )}

        {!selNode && selHub && (
          <>
            <div className={styles.panelHead}>
              <button type="button" className={styles.pclose} onClick={deselect} aria-label="close">
                ✕
              </button>
              <div className={styles.pkicker}>
                <span className={`${styles.pswatch} ${styles.pswatchHub}`} />
                {hubKicker}
              </div>
              <div className={styles.pname}>{selHub.label}</div>
              <div className={styles.pline}>{selHub.weight} people here tonight</div>
            </div>
            <div className={styles.pbody}>
              <div className={`${styles.sec} ${styles.secFirst}`}>WHO’S HERE</div>
              {(selHub.memberIds ?? []).map((id) => {
                const m = byId.get(id);
                if (!m) return null;
                return (
                  <button key={id} type="button" className={styles.conn} onClick={() => selectPerson(id)}>
                    <span className={styles.connVia}>
                      <span className={styles.pswatch} style={{ background: hueOf(m) }} />
                      {m.motive ? pretty(m.motive) : "—"}
                    </span>
                    <div className={styles.connWho}>
                      {m.name} <small>· {m.title || m.school || ""}</small>
                    </div>
                  </button>
                );
              })}
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
              Receipt —{" "}
              <span
                className={`${styles.badge} ${
                  receipt.type === "seek"
                    ? receipt.inbound
                      ? styles.bSeekIn
                      : styles.bSeekOut
                    : TYPE_BADGE[receipt.type]
                }`}
              >
                {receipt.type}
                {receipt.mutual ? " · MUTUAL" : ""}
              </span>{" "}
              via “{receipt.via}”
            </div>
            <div className={styles.rcols}>
              {[receipt.left, receipt.right].map((side, i) =>
                side ? (
                  <div key={i}>
                    <div className={styles.rname}>{side.name}</div>
                    <div className={styles.rq}>{side.label}</div>
                    <div className={styles.rtxt}>
                      {highlightParts(side.quote, receipt.via).map((p, j) =>
                        p.on ? <mark key={j}>{p.t}</mark> : <span key={j}>{p.t}</span>,
                      )}
                    </div>
                  </div>
                ) : null,
              )}
            </div>
            {receipt.prov && <div className={styles.rprov}>{receipt.prov}</div>}
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
  const badgeClass = row.type === "seek" ? (row.inbound ? styles.bSeekIn : styles.bSeekOut) : TYPE_BADGE[row.type];
  const via =
    row.type === "seek"
      ? `${row.mutual ? "mutual · " : row.inbound ? "they seek · " : "you seek · "}${row.via}`
      : row.via;
  return (
    <button type="button" className={styles.conn} onClick={() => onOpen(row)}>
      <span className={styles.connVia}>
        <span className={styles.connN}>{String(n).padStart(2, "0")}</span>
        <span className={`${styles.badge} ${badgeClass}`}>{via.slice(0, 40)}</span>
      </span>
      <div className={styles.connWho}>
        {other.name} <small>· {other.title || other.school || ""}</small>
      </div>
    </button>
  );
}
