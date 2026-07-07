// passport/template.tsx — Teri's replaceable-text target.
// A clean, presentational passport card. ZERO hardcoded content: every string (passport data AND
// UI labels) arrives via props. Front = name, line2, magic tagline, the two finds + whys (black on light).
// Back = hidden_prompt over the gradient band built from gradient.stops.
//
// DESIGN TOKENS: Teri's tokens are consumed as CSS custom properties with safe fallbacks. We do NOT
// statically `import "./tokens.css"` here — a static import of a not-yet-existing file would break the
// build (graceful-if-absent per the contract). If passport/tokens.css exists, import it ONCE in
// app/layout.tsx and this component picks up every --passport-* var automatically.

import * as React from "react";
import type { Passport, GradientStop } from "@/passport/schema";

export type PassportLabels = {
  /** heading above the two people to meet, e.g. "You should meet" */
  findHeading: string;
  /** heading above the hidden mission on the back, e.g. "Your hidden mission" */
  hiddenHeading: string;
  /** small heading above the magic inference tagline, e.g. "Read on you" (optional) */
  magicHeading: string;
};

const DEFAULT_LABELS: PassportLabels = {
  findHeading: "You should meet",
  hiddenHeading: "Your hidden mission",
  magicHeading: "A read on you",
};

export type PassportCardProps = {
  passport: Passport;
  /** which face(s) to render; default renders both stacked */
  side?: "front" | "back" | "both";
  /** override any UI label (Teri's replaceable text) */
  labels?: Partial<PassportLabels>;
  className?: string;
  style?: React.CSSProperties;
};

function gradientCss(stops: GradientStop[]): string {
  const parts = [...stops]
    .sort((a, b) => a.at - b.at)
    .map((s) => `${s.color} ${Math.round(s.at * 100)}%`);
  return `linear-gradient(135deg, ${parts.join(", ")})`;
}

// tokens-with-fallback (Teri overrides via passport/tokens.css → :root { --passport-*: … })
const S = {
  card: {
    fontFamily: "var(--passport-font, ui-sans-serif, system-ui, -apple-system, sans-serif)",
    background: "var(--passport-bg, #faf9f6)",
    color: "var(--passport-ink, #111111)",
    borderRadius: "var(--passport-radius, 18px)",
    border: "1px solid var(--passport-border, rgba(0,0,0,0.10))",
    padding: "var(--passport-pad, 28px)",
    width: "100%",
    maxWidth: "var(--passport-w, 380px)",
    boxSizing: "border-box" as const,
  },
  name: {
    fontSize: "var(--passport-name-size, 28px)",
    fontWeight: 700,
    letterSpacing: "-0.02em",
    lineHeight: 1.1,
  },
  line2: {
    marginTop: 4,
    fontSize: "var(--passport-line2-size, 15px)",
    color: "var(--passport-muted, #555555)",
  },
  magic: {
    marginTop: 14,
    fontStyle: "italic" as const,
    fontSize: "var(--passport-magic-size, 15px)",
    color: "var(--passport-ink, #111111)",
    lineHeight: 1.4,
  },
  kicker: {
    marginTop: 22,
    marginBottom: 8,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase" as const,
    color: "var(--passport-muted, #555555)",
  },
  findRow: {
    padding: "12px 0",
    borderTop: "1px solid var(--passport-border, rgba(0,0,0,0.10))",
  },
  findName: { fontSize: 16, fontWeight: 600 },
  findWhy: {
    marginTop: 3,
    fontSize: 14,
    lineHeight: 1.45,
    color: "var(--passport-muted, #444444)",
  },
  back: {
    position: "relative" as const,
    borderRadius: "var(--passport-radius, 18px)",
    overflow: "hidden" as const,
    minHeight: 200,
    display: "flex",
    alignItems: "flex-end",
    padding: "var(--passport-pad, 28px)",
    boxSizing: "border-box" as const,
    color: "#ffffff",
  },
  backKicker: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase" as const,
    opacity: 0.85,
  },
  backPrompt: {
    marginTop: 6,
    fontSize: "var(--passport-prompt-size, 20px)",
    fontWeight: 600,
    lineHeight: 1.25,
    textShadow: "0 1px 12px rgba(0,0,0,0.35)",
  },
};

function Front({ passport, labels }: { passport: Passport; labels: PassportLabels }) {
  return (
    <div style={S.card} data-passport-face="front">
      <div style={S.name}>{passport.name}</div>
      {passport.line2 ? <div style={S.line2}>{passport.line2}</div> : null}
      <div style={S.magic}>
        <span style={{ ...S.backKicker, display: "block", color: "var(--passport-muted, #999)", marginBottom: 4 }}>
          {labels.magicHeading}
        </span>
        {passport.magic_inference}
      </div>

      <div style={S.kicker}>{labels.findHeading}</div>
      {passport.find.map((f, i) => (
        <div key={`${f.personId}-${i}`} style={S.findRow}>
          <div style={S.findName}>{f.name}</div>
          <div style={S.findWhy}>{f.why}</div>
        </div>
      ))}
    </div>
  );
}

function Back({ passport, labels }: { passport: Passport; labels: PassportLabels }) {
  return (
    <div
      style={{ ...S.back, backgroundImage: gradientCss(passport.gradient.stops) }}
      data-passport-face="back"
      data-gradient-seed={passport.gradient.seed}
    >
      {/* readability scrim under the prompt */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to top, rgba(0,0,0,0.45), rgba(0,0,0,0) 55%)",
        }}
      />
      <div style={{ position: "relative" }}>
        <div style={S.backKicker}>{labels.hiddenHeading}</div>
        <div style={S.backPrompt}>{passport.hidden_prompt}</div>
      </div>
    </div>
  );
}

export function PassportCard({ passport, side = "both", labels, className, style }: PassportCardProps) {
  const merged: PassportLabels = { ...DEFAULT_LABELS, ...labels };
  return (
    <div
      className={className}
      style={{ display: "grid", gap: 16, width: "100%", maxWidth: S.card.maxWidth, ...style }}
      data-passport-id={passport.personId}
    >
      {(side === "front" || side === "both") && <Front passport={passport} labels={merged} />}
      {(side === "back" || side === "both") && <Back passport={passport} labels={merged} />}
    </div>
  );
}

export default PassportCard;
