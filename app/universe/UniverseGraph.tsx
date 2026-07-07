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
}

const REL_LINK_WIDTH: Partial<Record<LinkType, number>> = {
  SHARES_VALUE: 1.4,
  IN_CLUSTER: 0.6,
};

export default function UniverseGraph({ payload, selectedId, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [palette] = useState<Palette>(() => readPalette());

  // Stable copy of the data (force-graph mutates x/y/source/target in place; we
  // must not corrupt the raw payload the panel reads from).
  const graphData = useMemo(
    () => ({
      nodes: payload.nodes.map((n) => ({ ...n })) as FGNode[],
      links: payload.links.map((l) => ({ ...l })) as FGLink[],
    }),
    [payload],
  );

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

  const radiusOf = (n: FGNode): number =>
    n.type === 'ValueCluster' ? 9 : n.type === 'Person' ? 5 : 3.5;

  // ---- value-cloud halos (drawn behind everything, in graph coords) ----
  const onRenderFramePre = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      ctx.save();
      for (const n of graphData.nodes) {
        if (n.type === 'Person' && n.cluster && typeof n.x === 'number' && typeof n.y === 'number') {
          const hue = hueFor(n.cluster);
          if (!hue) continue;
          const R = 24;
          const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, R);
          g.addColorStop(0, withAlpha(hue, 0.16));
          g.addColorStop(1, withAlpha(hue, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(n.x, n.y, R, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // brighter core glow under each cluster hub
      for (const n of graphData.nodes) {
        if (n.type === 'ValueCluster' && typeof n.x === 'number' && typeof n.y === 'number') {
          const hue = hueFor(n.cluster) ?? palette.personTint;
          const R = 34;
          const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, R);
          g.addColorStop(0, withAlpha(hue, 0.22));
          g.addColorStop(1, withAlpha(hue, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(n.x, n.y, R, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },
    [graphData, hueFor, palette],
  );

  // ---- node painting ----
  const nodeCanvasObject = useCallback(
    (node: FGNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = radiusOf(node);
      const selected = node.id === selectedId;

      if (node.type === 'Person' || node.type === 'ValueCluster') {
        const hue = hueFor(node.cluster) ?? palette.personTint;
        // glass orb: white highlight → hue tint
        const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
        grad.addColorStop(0, palette.personCore);
        grad.addColorStop(1, hue);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = selected ? 1.4 : 0.5;
        ctx.strokeStyle = selected ? palette.ringStrong : palette.ring;
        ctx.stroke();
      } else {
        // affinity hub: quiet neutral dot
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = palette.affinity;
        ctx.fill();
        ctx.lineWidth = selected ? 1.2 : 0.4;
        ctx.strokeStyle = selected ? palette.ringStrong : palette.ring;
        ctx.stroke();
      }

      // labels — sized in constant screen px, gated by zoom to avoid clutter
      const showLabel =
        node.type === 'ValueCluster' ||
        (node.type === 'Person' && scale > 1.15) ||
        (node.type !== 'Person' && scale > 1.9); // affinity hubs only when zoomed in
      if (showLabel && node.label) {
        const fontPx = (node.type === 'ValueCluster' ? 12 : node.type === 'Person' ? 10 : 8) / scale;
        ctx.font = `${node.type === 'ValueCluster' ? 600 : 420} ${fontPx}px ${
          getComputedStyle(document.documentElement).getPropertyValue('--usp-font-sans') || 'sans-serif'
        }`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle =
          node.type === 'ValueCluster'
            ? palette.ink
            : node.type === 'Person'
              ? palette.ink
              : palette.affinityInk;
        ctx.fillText(node.label, x, y + r + 1.5 / scale);
      }
    },
    [selectedId, hueFor, palette],
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

  const linkColor = useCallback(
    (link: FGLink) => {
      if (link.type === 'SHARES_VALUE') return palette.shareLink;
      if (link.type === 'IN_CLUSTER') {
        const src = link.source as FGNode | string;
        const cluster = typeof src === 'object' ? src.cluster : undefined;
        return withAlpha(hueFor(cluster) ?? palette.personTint, 0.22);
      }
      return palette.linkFaint;
    },
    [palette, hueFor],
  );

  const linkWidth = useCallback((link: FGLink) => REL_LINK_WIDTH[link.type] ?? 0.5, []);
  const linkLineDash = useCallback(
    (link: FGLink) => (link.type === 'IN_CLUSTER' ? [2, 3] : null),
    [],
  );

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
