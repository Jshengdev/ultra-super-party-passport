/**
 * All texture filter definitions, mounted once inside the passport document
 * SVG so they serialize with it on export. Numeric filter values are science
 * values (feTurbulence frequencies, displacement scales), the one allowed
 * class of literals outside tokens.css.
 */
export function TextureDefs() {
  return (
    <defs>
      {/* barely-there press texture for printed data text */}
      <filter id="press-text" x="-2%" y="-6%" width="104%" height="112%">
        <feTurbulence type="fractalNoise" baseFrequency="0.04 0.06" numOctaves="2" seed="7" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="0.7" />
      </filter>

      {/* slightly stronger press for the mrz band and section borders */}
      <filter id="press-strong" x="-2%" y="-12%" width="104%" height="124%">
        <feTurbulence type="fractalNoise" baseFrequency="0.05 0.08" numOctaves="2" seed="11" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="1.4" />
      </filter>

      {/* debossed window emboss for the empty photo frames */}
      <filter id="deboss" x="-8%" y="-8%" width="116%" height="116%">
        <feDropShadow dx="0.5" dy="0.7" stdDeviation="0.3" floodColor="#ffffff" floodOpacity="0.85" />
        <feDropShadow dx="-0.4" dy="-0.6" stdDeviation="0.35" floodColor="#000000" floodOpacity="0.22" />
      </filter>

      {/* printed-sticker drop for the nametag */}
      <filter id="sticker-shadow" x="-10%" y="-10%" width="120%" height="124%">
        <feDropShadow dx="0" dy="2.2" stdDeviation="1.6" floodColor="#000000" floodOpacity="0.32" />
      </filter>

      {/* full-bleed paper grain, multiplied over the page */}
      <filter id="paper-grain" x="0%" y="0%" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="5" stitchTiles="stitch" result="noise" />
        <feColorMatrix
          in="noise"
          type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.3 0.3 0.3 0 0"
        />
      </filter>

      {/* subtle vertical paper tone */}
      <linearGradient id="paper-tone" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
        <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="1" style={{ stopColor: 'var(--paper-shadow)' }} stopOpacity="0.4" />
      </linearGradient>

      {/* pastel chromatic placeholder for the empty photo window */}
      <linearGradient id="photo-holo" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style={{ stopColor: 'color-mix(in oklch, var(--paper) 55%, var(--holo-2))' }} />
        <stop offset="0.3" style={{ stopColor: 'color-mix(in oklch, var(--paper) 55%, var(--holo-1))' }} />
        <stop offset="0.55" style={{ stopColor: 'color-mix(in oklch, var(--paper) 55%, var(--holo-3))' }} />
        <stop offset="0.8" style={{ stopColor: 'color-mix(in oklch, var(--paper) 55%, var(--holo-4))' }} />
        <stop offset="1" style={{ stopColor: 'color-mix(in oklch, var(--paper) 55%, var(--holo-5))' }} />
      </linearGradient>

      {/* specular edge sheen clipped over the sticker */}
      <linearGradient id="sticker-sheen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.3" />
        <stop offset="0.4" stopColor="#ffffff" stopOpacity="0" />
      </linearGradient>
    </defs>
  )
}
