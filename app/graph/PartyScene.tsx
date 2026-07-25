"use client";

/**
 * app/graph/PartyScene.tsx — the LA intern party, in pepl's scene.
 *
 * The design is pepl's, ported whole (app/graph/pepl/): the Monet-graded sheet,
 * the soap-bubble lens, serif group inscriptions, dot labels, the segment
 * boards, the stamp burst around a focused name. The CONTENT is ours — the 312
 * baked guests in public/graph/graph.json.
 *
 * This component's whole job is the seam: load the room, seed the adapter, and
 * mount the scene ONCE. The scene is an imperative WebGL app that owns its
 * canvas for its whole lifetime, so it must never be conditionally unmounted and
 * remounted — that is why there is no entry animation gating it.
 */

import { useEffect, useState } from "react";
import { seedScene, type RoomNode } from "./pepl/adapter";
import styles from "./graph.module.css";

/** Nodes as the v2 emitter bakes them. Display-safe fields only. */
interface BakedNode {
  id: string;
  name: string;
  title?: string;
  school?: string | null;
  company?: string | null;
  motive?: string | null;
  mission?: string | null;
  hometown?: string | null;
  instagram?: string | null;
  favorite?: string | null;
  kind?: string;
}

export default function PartyScene() {
  const [Scene, setScene] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/graph/graph.json", { cache: "force-cache" });
        if (!res.ok) throw new Error(`graph.json ${res.status}`);
        const json = (await res.json()) as { nodes?: BakedNode[] };
        const people = (json.nodes ?? []).filter((n) => !n.kind || n.kind === "person");
        if (!people.length) throw new Error("the room has no people in it");
        if (cancelled) return;

        // seed BEFORE the scene module is evaluated: the scene reads the adapter
        // at module scope, so importing first would capture an empty room
        seedScene(people as RoomNode[]);
        const mod = await import("./pepl/PeplGraph");
        if (cancelled) return;
        setScene(() => mod.default as React.ComponentType);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className={styles.boot} role="alert">
        the room didn’t load — {error}
      </div>
    );
  }
  if (!Scene) return <div className={styles.boot}>assembling the room…</div>;
  return <Scene />;
}
