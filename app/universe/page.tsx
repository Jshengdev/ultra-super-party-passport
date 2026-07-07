'use client';

/**
 * /universe — the WOW surface (G2).
 *
 * Fetches the live party graph from /api/graph. If Aura is not configured the
 * route answers 503 and we transparently fall back to /api/graph?demo=1 so the
 * experience is always renderable (with an honest DEMO banner — never a silent
 * pretend-live). Click a node → side panel with their links, value-cloud, the
 * peers they share values with, and a link into their passport.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import '@/passport/tokens.css';
import styles from './universe.module.css';
import UniverseGraph from './UniverseGraph';
import PersonPanel from './PersonPanel';
import { buildAdjacency, type GraphNode, type GraphPayload } from './lib/graph';
import { clusterColor, readPalette, type Palette } from './lib/palette';

type Status = 'loading' | 'live' | 'demo' | 'error';

export default function UniversePage() {
  const [status, setStatus] = useState<Status>('loading');
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);

  useEffect(() => {
    setPalette(readPalette());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(process.env.NEXT_PUBLIC_GRAPH_API || '/api/graph', { cache: 'no-store' });
        if (res.status === 200) {
          const data = (await res.json()) as GraphPayload;
          if (cancelled) return;
          setPayload(data);
          setStatus(data.meta?.source === 'demo' ? 'demo' : 'live');
          return;
        }
        if (res.status === 503) {
          const demoRes = await fetch('/api/graph', { cache: 'no-store' });
          const demo = (await demoRes.json()) as GraphPayload;
          if (cancelled) return;
          setPayload(demo);
          setStatus('demo');
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        if (cancelled) return;
        setErrorMsg(body.message ?? body.error ?? `Request failed (${res.status})`);
        setStatus('error');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : 'Network error');
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const adjacency = useMemo(() => (payload ? buildAdjacency(payload) : new Map()), [payload]);
  const clusterNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of payload?.nodes ?? []) {
      if (n.type === 'ValueCluster' && n.cluster) m.set(n.cluster, n.label);
    }
    return m;
  }, [payload]);

  const hueFor = useCallback(
    (clusterId: string | null | undefined) => clusterColor(clusterId, palette?.spectrum ?? []),
    [palette],
  );
  const clusterName = useCallback(
    (clusterId: string | null | undefined) => (clusterId ? clusterNames.get(clusterId) ?? clusterId : ''),
    [clusterNames],
  );

  const selectedNode = useMemo(
    () => payload?.nodes.find((n) => n.id === selectedId) ?? null,
    [payload, selectedId],
  );

  const onSelect = useCallback((node: GraphNode | null) => setSelectedId(node ? node.id : null), []);

  const [query, setQuery] = useState('');
  const searchMatches = useMemo(() => {
    const s = query.trim().toLowerCase();
    if (s.length < 2 || !payload) return [];
    return payload.nodes
      .filter((n) => n.type === 'Person' && n.label.toLowerCase().includes(s))
      .slice(0, 6);
  }, [query, payload]);

  const counts = payload?.meta?.counts;

  return (
    <main className={styles.shell}>
      <div className={styles.canvasHost}>
        {payload && payload.nodes.length > 0 && (
          <UniverseGraph payload={payload} selectedId={selectedId} onSelect={onSelect} />
        )}
      </div>

      {(status === 'live' || status === 'demo') && (
        <div
          style={{
            position: 'absolute', top: 18, left: '50%', transform: 'translateX(-50%)',
            zIndex: 30, width: 'min(360px, 86vw)', display: 'flex', flexDirection: 'column', gap: 6,
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="what’s your name?"
            aria-label="search your name"
            style={{
              width: '100%', padding: '12px 20px', borderRadius: 999,
              border: '1.5px solid var(--usp-ink, #2a2a28)', background: 'var(--usp-card, #fff)',
              fontSize: 15, textAlign: 'center', outline: 'none',
              boxShadow: '0 10px 32px rgba(42,42,40,0.16)', fontWeight: 500,
            }}
          />
          {searchMatches.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                setSelectedId(m.id);
                setQuery('');
              }}
              style={{
                width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                padding: '9px 18px', borderRadius: 12, border: '1px solid var(--usp-line, #e2e2de)',
                background: 'var(--usp-card, #fff)', cursor: 'pointer', fontSize: 14,
              }}
            >
              <span>{m.label}</span>
              <span style={{ fontSize: 12, color: 'var(--usp-muted, #8a8a86)' }}>find yourself →</span>
            </button>
          ))}
        </div>
      )}

      <header className={styles.header}>
        <div className={styles.titleWrap}>
          <h1 className={styles.title}>The Universe</h1>
          {counts && (
            <p className={styles.subtitle}>
              {counts.people} people · {counts.clusters} value clouds
            </p>
          )}
        </div>
        {status === 'live' && (
          <span className={styles.banner}>
            <span className={styles.dot} /> Live graph
          </span>
        )}
        {status === 'demo' && (
          <span className={styles.banner}>
            <span className={`${styles.dot} ${styles.dotDemo}`} /> Demo data — Aura not connected
          </span>
        )}
        {status === 'error' && (
          <span className={styles.banner}>
            <span className={`${styles.dot} ${styles.dotError}`} /> Graph unavailable
          </span>
        )}
      </header>

      {(status === 'live' || status === 'demo') && payload && payload.nodes.length > 0 && (
        <div className={styles.legend}>
          <div className={styles.legendRow}>
            <span className={styles.legendSwatch} style={{ background: 'var(--usp-spectrum-3)' }} /> A person
          </div>
          <div className={styles.legendRow}>
            <span className={styles.legendSwatch} style={{ background: 'var(--usp-spectrum-2)', opacity: 0.5 }} /> A value cloud
          </div>
          <div className={styles.legendRow}>
            <span className={styles.legendSwatch} style={{ background: 'var(--usp-affinity)' }} /> School / work / craft
          </div>
          <div className={styles.legendHint}>Click anyone to open them.</div>
        </div>
      )}

      {status === 'loading' && (
        <div className={styles.center}>
          <div className={styles.spinner} />
          <div className={styles.centerBody}>Assembling the room…</div>
        </div>
      )}

      {status === 'error' && (
        <div className={styles.center}>
          <div className={styles.centerTitle}>The graph is offline</div>
          <div className={styles.centerBody}>{errorMsg}</div>
        </div>
      )}

      {selectedNode && (
        <PersonPanel
          node={selectedNode}
          adjacency={adjacency}
          hueFor={hueFor}
          clusterName={clusterName}
          onSelectNode={setSelectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  );
}
