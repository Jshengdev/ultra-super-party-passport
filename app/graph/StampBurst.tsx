"use client";

/**
 * app/graph/StampBurst.tsx — a fact about a person, as a passport stamp.
 *
 * The artifacts and the injection pipeline are OURS (`passport/document/`); the
 * choreography is pepl's, ported verbatim because it is what makes a stamp read
 * as physically applied rather than faded in:
 *
 *   pop   480ms cubic-bezier(.16,1,.3,1), 85ms stagger, overshoot to 1.06 at 72%
 *   peel  320ms cubic-bezier(.45,0,.85,.55), 45ms stagger, lift + rotate + skew
 *   hinge transform-origin 30% 100% — it peels from a sticker corner
 *
 * Every stamp is one of three Figma artifacts re-used as a WINDOW: the same art
 * carries a different fact depending on the values injected. That is why cohort
 * facts ("one of 28 aiming to design") need no new SVG — they are a round stamp
 * with different words in it.
 *
 * BROWSER ONLY. injectSvg needs DOMParser, so injection is deferred to an effect
 * and the burst renders nothing on the server.
 */

import { useEffect, useMemo, useState } from "react";
import { ASSETS, type AssetKey } from "@/passport/document/assets";
import { injectSvg, withRootAttrs } from "@/passport/document/injectSvg";
import styles from "./stamps.module.css";

/** One stamp window: which artifact, and the words that go in it. */
export interface StampSpec {
  /** stable id — drives the React key so a person switch remounts the burst */
  id: string;
  asset: AssetKey;
  /** CHANGE_<field> → value. Every declared field of the asset must be present. */
  values: Record<string, string>;
  /** resting tilt, degrees */
  rot: number;
}

/** Fan geometry. Extendable: add a row and the burst grows. */
const TILTS = [-8, 3, 10, -5, 7, -3];

function clampField(v: string, max: number): string {
  const s = v.trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Fill every declared placeholder of an asset. injectSvg THROWS on a missing
 * field rather than rendering a blank, so unspecified slots get an empty string
 * deliberately — a stamp with a quiet slot beats a crashed panel.
 */
function completeValues(asset: AssetKey, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ASSETS[asset].fields) out[f] = clampField(values[f] ?? "", 120);
  return out;
}

export default function StampBurst({ specs, on }: { specs: StampSpec[]; on: boolean }) {
  // injectSvg is DOMParser-based; never run it during SSR
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const svgs = useMemo(() => {
    if (!mounted) return [];
    return specs.map((spec) => {
      const def = ASSETS[spec.asset];
      try {
        const injected = injectSvg(def.raw, completeValues(spec.asset, spec.values));
        // strip the fixed width/height so the artifact scales to its box
        return withRootAttrs(injected, { width: "100%", height: "100%" }, []);
      } catch {
        // a malformed artifact must not take the panel down with it
        return null;
      }
    });
  }, [specs, mounted]);

  if (!mounted) return null;

  return (
    <div className={styles.burst} aria-hidden={!on}>
      {specs.map((spec, i) => {
        const markup = svgs[i];
        if (!markup) return null;
        const def = ASSETS[spec.asset];
        return (
          <div
            key={spec.id}
            className={`${styles.stamp} ${on ? styles.in : styles.out}`}
            style={
              {
                "--i": i,
                "--rot": `${spec.rot ?? TILTS[i % TILTS.length]}deg`,
                aspectRatio: `${def.width} / ${def.height}`,
              } as React.CSSProperties
            }
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        );
      })}
    </div>
  );
}
