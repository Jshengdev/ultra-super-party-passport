'use client';

/**
 * UniverseGraph — the force-graph canvas.
 *
 * DESIGN LAW (raw/0012): NOT space themed. Clean light canvas; people are soft
 * "glass orbs" (radial highlight → cluster tint); value-clusters glow as halo
 * clouds behind their members; affinity hubs (school/major/company/activity) are
 * quiet neutral dots. All colours are READ from tokens.css via palette.ts — the
 * canvas never invents a hex.
 *
 * react-force-graph-2d touches `window`, so it is dynamically imported with
 * ssr:false. This whole component therefore only ever runs client-side, which is
 * why reading the palette at init is safe (no SSR / hydration mismatch).
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ForceGraphMethods,
  LinkObject,
  NodeObject,
} from 'react-force-graph-2d';
import type { GraphLink, GraphNode, GraphPayload, LinkType } from './lib/graph';
import { clusterColor, readPalette, withAlpha, type Palette } from './lib/palette';

type FGNode = NodeObject<GraphNode>;
type FGLink = LinkObject<GraphNode, GraphLink>;

interface FGProps {
  ref?: React.Ref<ForceGraphMethods<GraphNode, GraphLink> | undefined>;
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
  onEngineStop?: () => void;
  cooldownTicks?: number;
  d3VelocityDecay?: number;
  minZoom?: number;
  maxZoom?: number;
  enableNodeDrag?: boolean;
}

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
}) as unknown as React.ComponentType<FGProps>;

interface Props {
  payload: GraphPayload;
  selectedId: string | null;
  onSelect: (node: GraphNode | null) => void;
  /** search matches: their labels render as a slow gradient wave (raw/0030) */
  matchedIds?: Set<string>;
}

// SHARES_VALUE never appears here: those edges are filtered out of the sim
// (see graphData below) and painted manually for the selected person only.
const REL_LINK_WIDTH: Partial<Record<LinkType, number>> = {
  IN_CLUSTER: 0.6,
};

// Force-layout tuning (raw/0026: organic attribute-mesh, not isolated pods).
// Attribute-hub spokes stay short (the fine web); IN_CLUSTER ties are longer
// and weak so value clouds read as tendencies, not silos.
// INTERESTED_IN gets a mid-length so shared interests BRIDGE clusters
const LINK_DISTANCE: Partial<Record<LinkType, number>> = {
  STUDIES_AT: 28,
  MAJORS_IN: 28,
  WORKS_AT: 28,
  DOES: 32,
  WORKING_ON: 34,
  IN_CLUSTER: 40,
  INTERESTED_IN: 36,
};
const IN_CLUSTER_STRENGTH = 0.15;
const CHARGE_STRENGTH = -28;

export default function UniverseGraph({ payload, selectedId, onSelect, matchedIds }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [palette] = useState<Palette>(() => readPalette());
  // Read once (not per node per frame); guarded like readPalette for the SSR pass.
  const [fontFamily] = useState<string>(() =>
    typeof document === 'undefined'
      ? 'sans-serif'
      : getComputedStyle(document.documentElement).getPropertyValue('--usp-font-sans').trim() ||
        'sans-serif',
  );

  // Stable copy of the data (force-graph mutates x/y/source/target in place; we
  // must not corrupt the raw payload the panel reads from).
  const graphData = useMemo(
    () => ({
      nodes: payload.nodes.map((n) => ({ ...n })) as FGNode[],
      // SHARES_VALUE edges are dense complete-subgraphs (3k+): physics-including them
      // collapses each cloud into an isolated pod (raw/0026's critique). They stay OUT
      // of the layout; the selected person's value-ties are painted manually instead.
      links: payload.links.filter((l) => l.type !== 'SHARES_VALUE').map((l) => ({ ...l })) as FGLink[],
    }),
    [payload],
  );

  const interestDegree = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of payload.links) {
      if (l.type !== 'INTERESTED_IN') continue;
      const t = String(typeof l.target === 'object' ? (l.target as GraphNode).id : l.target);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [payload]);

  const valueMates = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of payload.links) {
      if (l.type !== 'SHARES_VALUE') continue;
      const a = String(typeof l.source === 'object' ? (l.source as GraphNode).id : l.source);
      const b = String(typeof l.target === 'object' ? (l.target as GraphNode).id : l.target);
      if (!m.has(a)) m.set(a, new Set());
      if (!m.has(b)) m.set(b, new Set());
      m.get(a)!.add(b);
      m.get(b)!.add(a);
    }
    return m;
  }, [payload]);

  const hueFor = useCallback(
    (clusterId: string | null | undefined) => clusterColor(clusterId, palette.spectrum),
    [palette],
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

  // ---- force tuning (raw/0026: organic spread, no isolation) ----
  // ForceGraph2D is dynamically imported and only mounts once the host is
  // measured, so fgRef.current is not available on the first effect run —
  // retry on rAF until it is, then shape the layout and reheat.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;

    // per-node degree over the SIMULATED links (SHARES_VALUE already excluded),
    // to reproduce d3's default strength heuristic for the non-cluster links.
    const degree = new Map<string, number>();
    const endId = (e: FGLink['source']): string =>
      String(typeof e === 'object' && e !== null ? (e as FGNode).id : e);
    for (const l of graphData.links) {
      for (const k of [endId(l.source), endId(l.target)]) {
        degree.set(k, (degree.get(k) ?? 0) + 1);
      }
    }

    const tune = () => {
      if (cancelled) return;
      const fg = fgRef.current;
      if (!fg) {
        raf = requestAnimationFrame(tune);
        return;
      }
      const linkForce = fg.d3Force('link');
      if (linkForce) {
        linkForce.distance((l: FGLink) => LINK_DISTANCE[l.type] ?? 30);
        linkForce.strength((l: FGLink) => {
          // weak cluster pull: clouds are tendencies, not silos
          if (l.type === 'IN_CLUSTER') return IN_CLUSTER_STRENGTH;
          // d3 default heuristic — hubs with many spokes pull each spoke less,
          // which is exactly what keeps the attribute mesh fine and organic.
          const s = degree.get(endId(l.source)) ?? 1;
          const t = degree.get(endId(l.target)) ?? 1;
          return 1 / Math.min(s, t);
        });
      }
      const charge = fg.d3Force('charge');
      if (charge) charge.strength(CHARGE_STRENGTH);
      fg.d3ReheatSimulation();
    };

    tune();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [graphData]);

  // ego-web of the selected node (direct link neighbors + value-mates): the lit set
  const egoSet = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const l of payload.links) {
      const a = String(typeof l.source === 'object' ? (l.source as GraphNode).id : l.source);
      const b = String(typeof l.target === 'object' ? (l.target as GraphNode).id : l.target);
      if (a === selectedId) set.add(b);
      if (b === selectedId) set.add(a);
    }
    for (const m of valueMates.get(selectedId) ?? []) set.add(m);
    return set;
  }, [selectedId, payload, valueMates]);

  // top people by degree — the only names shown at mid-zoom (dial 1: progressive disclosure)
  const labelElect = useMemo(() => {
    const deg = new Map<string, number>();
    for (const l of payload.links) {
      const a = String(typeof l.source === 'object' ? (l.source as GraphNode).id : l.source);
      const b = String(typeof l.target === 'object' ? (l.target as GraphNode).id : l.target);
      deg.set(a, (deg.get(a) ?? 0) + 1);
      deg.set(b, (deg.get(b) ?? 0) + 1);
    }
    return new Set(
      payload.nodes
        .filter((n) => n.type === 'Person')
        .sort((a, b) => (deg.get(String(b.id)) ?? 0) - (deg.get(String(a.id)) ?? 0))
        .slice(0, 24)
        .map((n) => String(n.id)),
    );
  }, [payload]);

  const radiusOf = (n: FGNode): number =>
    n.type === 'ValueCluster' ? 4.5 : n.type === 'Person' ? 5 : n.type === 'Interest' ? 3 : 3.5;

  // ---- value-cloud halos (drawn behind everything, in graph coords) ----
  const onRenderFramePre = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      ctx.save();
      // idle halos removed (raw/0034: "remove the glow") — the room rests as flat ink
      // dots on paper; color belongs to touch (the lit ego-web) and the touchpoint tags.
      // the selected person's web: value-ties + a halo ring, painted (no physics)
      if (selectedId) {
        const sel = graphData.nodes.find((n) => n.id === selectedId);
        const mates = valueMates.get(selectedId);
        if (sel && typeof sel.x === 'number' && typeof sel.y === 'number') {
          if (mates) {
            for (const n of graphData.nodes) {
              if (!mates.has(String(n.id)) || typeof n.x !== 'number' || typeof n.y !== 'number') continue;
              const hue = hueFor(sel.cluster) ?? palette.personTint;
              ctx.strokeStyle = withAlpha(hue, 0.5);
              ctx.lineWidth = 0.9;
              ctx.beginPath();
              ctx.moveTo(sel.x, sel.y);
              ctx.lineTo(n.x, n.y);
              ctx.stroke();
            }
          }
          const R = 16;
          const g = ctx.createRadialGradient(sel.x, sel.y, 0, sel.x, sel.y, R);
          g.addColorStop(0, withAlpha(palette.ringStrong, 0.35));
          g.addColorStop(1, withAlpha(palette.ringStrong, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(sel.x, sel.y, R, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },
    [graphData, hueFor, palette, selectedId, valueMates],
  );

  // ---- node painting ----
  const nodeCanvasObject = useCallback(
    (node: FGNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = radiusOf(node);
      const selected = node.id === selectedId;

      // focus+context (dial 2): when someone is selected, everything outside
      // their web recedes to paper.
      const dimmed = egoSet ? !egoSet.has(String(node.id)) : false;
      ctx.globalAlpha = dimmed ? 0.12 : 1;

      if (node.type === 'Person') {
        // dial 3: a person is a small ink dot; their cloud speaks only as a soft halo
        const hue = hueFor(node.cluster) ?? palette.personTint;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(palette.ink, selected ? 0.95 : 0.65);
        ctx.fill();
        ctx.lineWidth = selected ? 1.4 : 0.5;
        ctx.strokeStyle = selected ? palette.ringStrong : withAlpha(hue, 0.5);
        ctx.stroke();
      } else if (node.type === 'ValueCluster') {
        const hue = hueFor(node.cluster) ?? palette.personTint;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(hue, 0.55);
        ctx.fill();
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = palette.ring;
        ctx.stroke();
      }
      const matched = matchedIds?.has(String(node.id)) ?? false;
      const shortLabel =
        node.type === 'Interest' && node.label
          ? node.label.split(/\s+/).slice(0, 3).join(' ')
          : node.label;
      const showLabel =
        selected ||
        (node.type === 'ValueCluster' && scale > 2.2) || // higher-level names live deeper, never on the instant view (raw/0034)
        (node.type === 'Person' &&
          ((scale > 0.95 && labelElect.has(String(node.id))) || scale > 1.35)) ||
        (node.type === 'Interest' && (interestDegree.get(String(node.id)) ?? 0) >= 2) || // shared interests ARE the instant layer
        (node.type !== 'Person' && node.type !== 'ValueCluster' && node.type !== 'Interest' && scale > 1.7);
      if ((showLabel || matched) && node.label && node.type === 'ValueCluster') {
        // the stamp: small-caps mono in a thin rounded outline, gently tilted
        const fontPx = 10 / scale;
        ctx.save();
        ctx.translate(x, y + r + 4 / scale);
        ctx.rotate(-0.052);
        ctx.font = `600 ${fontPx}px ${getComputedStyle(document.documentElement).getPropertyValue('--usp-font-mono') || 'monospace'}`;
        const text = node.label.toUpperCase();
        const w = ctx.measureText(text).width;
        const padX = 6 / scale;
        const padY = 4 / scale;
        const hue = hueFor(node.cluster) ?? palette.ink;
        ctx.strokeStyle = withAlpha(hue, 0.75);
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.roundRect(-w / 2 - padX, 0, w + padX * 2, fontPx + padY * 2, 4 / scale);
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = withAlpha(palette.ink, 0.8);
        ctx.fillText(text, 0, padY);
        ctx.restore();
      } else if ((showLabel || matched) && node.label) {
        const fontPx = (node.type === 'Person' ? 10 : 8) / scale;
        ctx.font = `${node.type === 'ValueCluster' ? 600 : matched ? 600 : 420} ${fontPx}px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const labelY = y + r + 1.5 / scale;
        // halo: a soft canvas-bg stroke keeps ink legible over the colored web
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = withAlpha(palette.canvasBg, selected || matched ? 0.9 : 0.7);
        if (matched) {
          // the match signal (raw/0030): each letter rides a slow wave, the spectrum
          // blended across the whole name. Painted per-letter in graph coords.
          const t = performance.now();
          const letters = (shortLabel ?? '').split('');
          const widths = letters.map((ch) => ctx.measureText(ch).width);
          const total = widths.reduce((a, b) => a + b, 0);
          const grad = ctx.createLinearGradient(x - total / 2, 0, x + total / 2, 0);
          const spec = palette.spectrum;
          const stops = [spec[0], spec[3], spec[4], spec[5] ?? spec[0]].filter(Boolean);
          stops.forEach((c, si) => grad.addColorStop(si / Math.max(1, stops.length - 1), c));
          ctx.textAlign = 'left';
          let cx0 = x - total / 2;
          letters.forEach((ch, li) => {
            const dy = Math.sin(t / 260 + li * 0.6) * (1.6 / scale);
            ctx.strokeText(ch, cx0, labelY + dy);
            ctx.fillStyle = grad;
            ctx.fillText(ch, cx0, labelY + dy);
            cx0 += widths[li];
          });
          ctx.textAlign = 'center';
        } else {
          ctx.strokeText(shortLabel ?? '', x, labelY);
          ctx.fillStyle =
            node.type === 'Person' || node.type === 'ValueCluster'
              ? palette.ink
              : palette.affinityInk;
          ctx.fillText(shortLabel ?? '', x, labelY);
        }
      }
      ctx.globalAlpha = 1;
    },
    [selectedId, hueFor, palette, fontFamily, matchedIds, egoSet, labelElect],
  );

  const nodePointerAreaPaint = useCallback(
    (node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, radiusOf(node) + 1.5, 0, Math.PI * 2);
      ctx.fill();
    },
    [],
  );

  const isSelectedEnd = useCallback(
    (link: FGLink) => {
      if (!selectedId) return false;
      const a = link.source as FGNode | string;
      const b = link.target as FGNode | string;
      return (
        String(typeof a === 'object' ? a.id : a) === selectedId ||
        String(typeof b === 'object' ? b.id : b) === selectedId
      );
    },
    [selectedId],
  );

  const linkColor = useCallback(
    (link: FGLink) => {
      const lit = isSelectedEnd(link);
      if (!lit && egoSet) return withAlpha(palette.ink, 0.03); // someone selected: the rest is paper
      if (!lit) {
        // idle room: quiet ink hairlines — color belongs to the lit web (90/10 budget)
        return withAlpha(palette.ink, link.type === 'IN_CLUSTER' ? 0.05 : 0.08);
      }
      const spec = palette.spectrum;
      switch (link.type) {
        case 'STUDIES_AT':  return withAlpha(spec[3] ?? palette.linkFaint, 0.85);
        case 'MAJORS_IN':   return withAlpha(spec[0] ?? palette.linkFaint, 0.85);
        case 'DOES':        return withAlpha(spec[4] ?? palette.linkFaint, 0.85);
        case 'WORKING_ON':  return withAlpha(spec[5] ?? spec[4] ?? palette.linkFaint, 0.85);
        case 'INTERESTED_IN': return withAlpha(spec[2] ?? spec[1] ?? palette.linkFaint, 0.85);
        case 'IN_CLUSTER': {
          const src = link.source as FGNode | string;
          const cluster = typeof src === 'object' ? src.cluster : undefined;
          return withAlpha(hueFor(cluster) ?? palette.personTint, 0.6);
        }
        default: return withAlpha(palette.linkFaint, 0.7);
      }
    },
    [palette, hueFor, isSelectedEnd, egoSet],
  );

  const linkWidth = useCallback(
    (link: FGLink) => (isSelectedEnd(link) ? 1.6 : REL_LINK_WIDTH[link.type] ?? 0.5),
    [isSelectedEnd],
  );
  const linkLineDash = useCallback(
    (link: FGLink) => (link.type === 'IN_CLUSTER' ? [2, 3] : null),
    [],
  );

  // While matches exist, nudge the renderer every frame so the wave animates even
  // when the force simulation has cooled (paint-only; zero physics reheat).
  useEffect(() => {
    if (!matchedIds || matchedIds.size === 0) return;
    let raf = 0;
    const tick = () => {
      const fg = fgRef.current as unknown as { refresh?: () => void } | undefined;
      fg?.refresh?.();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [matchedIds]);

  const handleNodeClick = useCallback(
    (node: FGNode) => onSelect(node as GraphNode),
    [onSelect],
  );
  const handleBgClick = useCallback(() => onSelect(null), [onSelect]);

  const onEngineStop = useCallback(() => {
    fgRef.current?.zoomToFit?.(500, 70);
  }, []);

  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0 }}>
      {size.w > 0 && size.h > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          backgroundColor={palette.canvasBg}
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
          onEngineStop={onEngineStop}
          d3VelocityDecay={0.32}
          minZoom={0.4}
          maxZoom={12}
          enableNodeDrag
        />
      )}
    </div>
  );
}
