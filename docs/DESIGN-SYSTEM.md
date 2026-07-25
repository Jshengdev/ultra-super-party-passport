# Design system — cream, film, glass

The single reference for how the rooms look. Values live in `passport/tokens.css`
(law f: that file is the handle); this doc says **why** and **which one to reach
for**. If a value here and a value there disagree, the token file wins.

Ported from the pepl design (`pepl-handoff.md`), reconciled with what already
shipped here. Where the two disagreed, the reconciliation is noted.

---

## 1. The ground

Cream, always dominant. Nothing in this product is dark — the orbs are
translucent, so the canvas is visible *through* every node, and a dark ground
turns glass to mud.

| token | value | role |
|---|---|---|
| `--usp-bg` | `#fbfaf7` | page |
| `--usp-canvas-bg` | `#fdfcfa` | the room — the brightest surface |
| `--usp-surface` | `#ffffff` | cards, panels, stamps' paper |
| `--usp-ink` | `#26242c` | primary text — soft charcoal, **never `#000`** |
| `--usp-ink-muted` | `#6f6c7a` | secondary |
| `--usp-ink-faint` | `#a3a0ad` | captions, legend |
| `--usp-border` | `rgba(120,110,170,0.16)` | hairlines — tinted, **never grey** |

> **Reconciliation.** pepl uses `--cream #f7f6f4` / `--ink #1a1918`. We keep our
> slightly brighter, cooler pair: our orbs are translucent and read against the
> ground, where pepl's dots are opaque ink on paper. Same intent, different
> physics.

## 2. The film palette

Every accent is a thin-film interference colour — the spectrum a soap film
cycles through as it thins. This is the brand.

| token | value | nm | use |
|---|---|---|---|
| `--usp-spectrum-0` | `#f0a8d0` | 190 | magenta — primary |
| `--usp-spectrum-1` | `#f6b98a` | 140 | gold — warm accent, hovers |
| `--usp-spectrum-2` | `#f2e08a` | — | citron |
| `--usp-spectrum-3` | `#9fe3c0` | 480 | mint — sparingly |
| `--usp-spectrum-4` | `#8fd8e8` | — | cyan |
| `--usp-spectrum-5` | `#9db8f0` | 240 | periwinkle — secondary, active states |
| `--usp-spectrum-6` | `#c3a8f0` | 420 | violet — sparingly |
| `--usp-spectrum-7` | `#f0a8bc` | — | rose, closes the loop |

**The one colour rule** (from pepl, adopted): a rendered colour is a film token
or a blend of two *adjacent* tokens. Never an arbitrary spectrum colour.

**The sanctioned exception** is the bubble itself — `app/universe/lib/bubble.ts`
runs a real thin-film sweep, because that is the reference component's own
physics rather than a palette choice.

### Primary action

The film hues are all high-lightness, so white text on any of them fails WCAG.
Deepened ends of the same spectrum carry white type:

- `--usp-accent-deep` `#4f49c4` — white text ≈ 7.4:1
- `--usp-accent-deep-2` `#6a5fd0`
- `--usp-cta` — the gradient of the two

## 3. Type

**One family: Plus Jakarta Sans**, loaded once in `app/layout.tsx` at weights
**400 / 500 / 600 only**. Semibold is the ceiling — a heavier value would
synthesise a fake bold rather than fail visibly, so the ceiling is enforced by
what is in the bundle.

`Hedvig Letters Serif 400` is the display/human voice — group inscriptions and
the focused-name echo. Nothing else.

`IBM Plex Mono 400` survives in exactly two places: the passport MRZ band and the
belief stamp's typewriter middle. Both are graphic devices, not text.

| step | size | role |
|---|---|---|
| `--usp-fs-xs` | 12px | captions, legend, meta |
| `--usp-fs-sm` | 14px | secondary, labels |
| `--usp-fs-md` | 16px | body — the readability floor |
| `--usp-fs-lg` | 20px | subheading |
| `--usp-fs-xl` | 28px | heading |
| `--usp-fs-2xl` | 40px | display |

**Sentence case everywhere. No `text-transform: uppercase`. No wide tracking on
small text.** A label that needs to recede drops to `--usp-fs-xs` +
`--usp-ink-faint` — it does not shout quietly.

> **Reconciliation.** pepl's chrome idiom is 9–11.5px lowercase at 0.08em
> tracking. We keep the 12px floor and zero tracking: wide-tracked micro-type was
> explicitly removed from this product. We took pepl's *lowercase* instinct, not
> its letterspacing.

## 4. Shape

**Corners are square.** `0` on panels, receipts, the legend, buttons, swatches.
The radius tokens survive for the few round things that are genuinely round
(orbs, pills in the passport document), but chrome does not use them.

Softness comes from shadow and blur, never from radius:

- `--usp-shadow-soft` — resting chrome
- `--usp-shadow-panel` — floating panels
- `--usp-shadow-bubble` — anything glass

Shadows bloom in film hues, not grey.

## 5. The stamps

Three Figma-exported SVG artifacts in `passport/document/assets.gen.ts`, injected
through `passport/document/injectSvg.ts`. They are the product's way of showing a
fact about a person.

| artifact | size | slots |
|---|---|---|
| `nametag` | 274×147 | `headerLabel` · `org` · `name` |
| `roundStamp` | 250×151 | `relation` · `ringText` · `name` |
| `beliefStamp` | 266×164 | `small` · `belief` · `name` |

Placeholders are `CHANGE_<field>`, matched by `/^CHANGE_[a-zA-Z]+$/` — **letters
only**, so `CHANGE_line2` will never match. A placeholder with no supplied value
throws rather than rendering blank.

Layout hints live on the enclosing `<text>`, never the tspan:
`data-wrap-width` greedy-wraps into tspans, `data-fit-width` squeezes via
`textLength`/`lengthAdjust`, `data-font` picks the face
(`document` | `typewriter` | `official`), `data-size` the size.

Width is *estimated*, not measured — there is no layout engine at injection time.
`textMetrics.ts` holds em-per-char factors, deliberately rounded **up** so a line
breaks early rather than overflowing: `document` 0.56, `official` 0.56,
`typewriter` 0.6 (exact, monospaced).

### Burst choreography

From pepl, adopted verbatim — this is the motion that makes stamps feel physical.

- **Pop** — `480ms cubic-bezier(0.16, 1, 0.3, 1)`, stagger `85ms`
  (0 / 85 / 170). Overshoot to `scale(1.06)` and `rot + 2.5deg` at 72%, settle
  to `scale(1)` at 100%. Enters from an offset with `scale(0.18)` and
  `rot − 17deg`.
- **Peel** — `320ms cubic-bezier(0.45, 0, 0.85, 0.55)`, stagger `45ms`.
  Lifts `translate(8px, -30px)`, `rot − 15deg`, `scale(0.82)`, `skewX(-5deg)`.
- `transform-origin: 30% 100%` — a bottom-left hinge, so it peels like a sticker
  corner.
- Resting tilt stays applied under reduced motion; only the animation is removed.
- Unmount **700ms** after `on:false`, comfortably past the 410ms peel.

## 6. Motion

| moment | duration / rate | easing |
|---|---|---|
| stamp pop | 480ms, stagger 85ms | `cubic-bezier(0.16, 1, 0.3, 1)` |
| stamp peel | 320ms, stagger 45ms | `cubic-bezier(0.45, 0, 0.85, 0.55)` |
| camera | rate 2.4/s | exponential ease |
| label fade | rate 5/s | exponential ease |
| name fade | rate 2.6/s | exponential ease |
| hover bloom | rate 6/s → 0.8 | exponential ease |
| press | `scale(0.96)`, 120ms | transform + background only |

Exponential easing means `x += (target − x) * (1 − exp(−dt * rate))` — frame-rate
independent, and it never overshoots.

**Reduced motion snaps everything.** Camera, labels, dot scale, stamps. No
exceptions.

## 7. What is deliberately NOT ported from pepl

- `lib/layout.ts` — collides with the graph pipeline's own layout module.
- The WebGL stack (`shaders.ts`, `monet.ts`, `webgl.ts`, `sheet.ts`) and the
  16-segment board machinery — that is pepl's renderer, not its design.
- `data/`, `scripts/` — its backend. This repo has its own.
- `html, body { overflow: hidden; height: 100% }` — a full-viewport-canvas
  assumption that silently kills scrolling elsewhere.
