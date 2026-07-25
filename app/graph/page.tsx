"use client";

/**
 * /graph — the LA intern party, in pepl's scene.
 *
 * Route shell only: pull the design tokens in per-route, then hand the surface
 * to a client-only component. The scene touches window/document/WebGL from first
 * paint, so it is dynamically imported with ssr:false — which also keeps this
 * route trivially static-exportable (no route handlers, no searchParams; deep
 * links live in location.hash).
 *
 * The previous force-graph room is still in ./GraphLab — kept, not deleted, so
 * the receipts UI it owns can be lifted across rather than rewritten.
 */

import dynamic from "next/dynamic";
import "@/passport/tokens.css";
import "./pepl/tokens.css"; // pepl's vocabulary, aliased onto ours — must load after
import styles from "./graph.module.css";

const PartyScene = dynamic(() => import("./PartyScene"), {
  ssr: false,
  loading: () => <div className={styles.boot}>assembling the room…</div>,
});

export default function GraphPage() {
  return (
    <main className={styles.shell}>
      <PartyScene />
    </main>
  );
}
