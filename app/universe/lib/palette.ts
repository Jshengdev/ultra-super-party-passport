/**
 * app/universe/lib/palette.ts — bridge Teri's design tokens into the <canvas>.
 *
 * DESIGN LAW (usp-v1 / party CLAUDE.md law f): typography + colours come ONLY from
 * `passport/tokens.css` custom properties. The force-graph canvas cannot use CSS
 * variables directly, so we READ them at runtime via getComputedStyle and feed the
 * resolved strings to the 2D context. tokens.css stays the single source of truth —
 * if Teri edits a token, the canvas follows on next mount. Fallbacks mirror the
 * shipped token values so the canvas still renders if the stylesheet is slow/absent.
 *
 * Client-only (touches `document`); imported solely by client components.
 */

export interface Palette {
  canvasBg: string;
  personCore: string;
  personTint: string;
  ink: string;
  muted: string;
  ring: string;
  ringStrong: string;
  affinity: string;
  affinityInk: string;
  linkFaint: string;
  shareLink: string;
  /** spectrum accents used to hue value clusters (glass-orb tints). */
  spectrum: string[];
}

const FALLBACK: Palette = {
  canvasBg: '#f7f6f3',
  personCore: '#ffffff',
  personTint: '#c9c6ff',
  ink: '#1b1b1f',
  muted: '#6b6b74',
  ring: 'rgba(27,27,31,0.14)',
  ringStrong: 'rgba(27,27,31,0.55)',
  affinity: '#e7e5e0',
  affinityInk: '#7a7873',
  linkFaint: 'rgba(27,27,31,0.08)',
  shareLink: 'rgba(120,110,220,0.38)',
  spectrum: ['#f2a6a0', '#f4c98a', '#8ad3c6', '#b3a6ef', '#f3a8c8', '#bcd98f', '#9cc9ef', '#a9a0e6'],
};

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

/** Read the live token values off :root. Safe to call only in the browser. */
export function readPalette(): Palette {
  if (typeof document === 'undefined') return FALLBACK;
  const s = getComputedStyle(document.documentElement);

  const spectrum: string[] = [];
  for (let i = 0; i < 8; i++) {
    const v = s.getPropertyValue(`--usp-spectrum-${i}`).trim();
    if (v) spectrum.push(v);
  }

  return {
    canvasBg: readVar(s, '--usp-canvas-bg', FALLBACK.canvasBg),
    personCore: readVar(s, '--usp-orb-core', FALLBACK.personCore),
    personTint: readVar(s, '--usp-orb-tint', FALLBACK.personTint),
    ink: readVar(s, '--usp-ink', FALLBACK.ink),
    muted: readVar(s, '--usp-ink-muted', FALLBACK.muted),
    ring: readVar(s, '--usp-ring', FALLBACK.ring),
    ringStrong: readVar(s, '--usp-ring-strong', FALLBACK.ringStrong),
    affinity: readVar(s, '--usp-affinity', FALLBACK.affinity),
    affinityInk: readVar(s, '--usp-affinity-ink', FALLBACK.affinityInk),
    linkFaint: readVar(s, '--usp-link-faint', FALLBACK.linkFaint),
    shareLink: readVar(s, '--usp-link-share', FALLBACK.shareLink),
    spectrum: spectrum.length > 0 ? spectrum : FALLBACK.spectrum,
  };
}

/** Stable, order-independent hash so a cluster id always maps to the same hue. */
function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** Pick a spectrum hue for a cluster id (deterministic). */
export function clusterColor(clusterId: string | null | undefined, spectrum: string[]): string | null {
  if (!clusterId) return null;
  const pal = spectrum.length > 0 ? spectrum : FALLBACK.spectrum;
  return pal[hash(clusterId) % pal.length];
}

/** Parse a hex/rgb colour to an rgba() string with the given alpha (for halos/glow). */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (rgb) {
    const parts = rgb[1].split(',').map((p) => p.trim());
    const [r, g, b] = parts;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return c;
}
