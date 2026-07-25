"use client";

/**
 * /graph — the Universe, re-fed with the real party data.
 *
 * Route shell only, mirroring app/universe/page.tsx: pull Teri's design tokens in
 * per-route, then hand the whole surface to a client-only component. GraphLab
 * touches `window`/`document` from first paint (the force canvas + sessionStorage
 * + the drag-the-CSV entry), so it is dynamically imported with ssr:false — which
 * also keeps this route trivially static-exportable (no route handlers, no
 * searchParams, deep links live in location.hash).
 */

import dynamic from "next/dynamic";
import "@/passport/tokens.css";
import styles from "./graph.module.css";

const GraphLab = dynamic(() => import("./GraphLab"), {
  ssr: false,
  loading: () => <div className={styles.boot}>assembling the room…</div>,
});

export default function GraphPage() {
  return (
    <main className={styles.shell}>
      <GraphLab />
    </main>
  );
}
