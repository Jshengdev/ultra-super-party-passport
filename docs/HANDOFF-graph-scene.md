# Handoff — /graph, the pepl scene

State as of `056c168` on branch `design/jakarta-chromatic` (branched off PR #1's
`feat/party-graph-v2`, not `master`). Working tree clean, nothing pushed.
`npx tsc --noEmit` is green. Read `docs/DESIGN-SYSTEM.md` first — it holds the
tokens, the stamp slot contract, and the motion values.

---

## What this is

`/graph` runs **pepl's renderer** over **our content**. The design layer was
ported into `app/graph/pepl/`; the 312 baked guests come from
`public/graph/graph.json` via `app/graph/pepl/adapter.ts`.

Deliberately NOT ported: pepl's `lib/adapter.ts`, `data/`, `scripts/` (its
backend), and `lib/layout.ts` — that one is copied as **`sheetLayout.ts`** so the
v2 pipeline's own `lib/layout.ts` is never shadowed. Zero new dependencies; the
WebGL is hand-rolled.

Run it: `npm run dev` → http://localhost:3000/graph. No credentials needed —
the room reads committed files. (`/universe` still needs `GRAPH_DEMO=1`.)

## Two bugs that cost hours — do not reintroduce

**1. The frozen scene.** `resize()` originally called `recreateTargets()` only
when the canvas *dimensions changed*. On remount the effect cleanup destroys the
render targets, but the `<canvas>` element survives with its width/height already
set — so the size check is false, the FBOs are never rebuilt, and every frame
returns at the `!rtScene` guard. One stale frame stays painted, **nothing
errors**. Fix is in `PeplGraph.tsx`: recreate on size change *or* when any target
is null. React double-invoked effects and Fast Refresh both trigger it.

**2. Vertical scan lines.** `weave()` in `monet.ts` takes `gl_FragCoord` in
*device pixels*. A coefficient near `2.0` puts the thread period at ~3px —
Nyquist — which beats against the pixel grid after dpr resampling and stripes the
whole frame. Period is now ~10px. The 15° rotation was never the problem; the
*frequency* is the correctness constraint.

### How to tell if the scene is actually running

Two obvious techniques are both **invalid here** and produced two wrong
diagnoses:

- `canvas.toDataURL()` on a WebGL canvas returns a **blank readback** unless
  `preserveDrawingBuffer` is set — constant bytes forever, regardless of state.
- Whole-page screenshot diffs always differ, because **the ticker scrolls
  continuously**.

What works: screenshot twice, crop to the scene region (exclude the bottom ~150px
of ticker), compare. Or instrument the frame loop and read the guard:
`L=… rtScene=… rtK=… rtB=… visible=…`.

## Where things live

| file | what |
|---|---|
| `app/graph/page.tsx` | route shell; imports `pepl/tokens.css` **after** `passport/tokens.css` |
| `app/graph/PartyScene.tsx` | the seam: fetch room → `seedScene()` → dynamic-import the scene. Must mount **once** — never gate it behind an animation |
| `app/graph/pepl/adapter.ts` | our `GraphAdapter`; groups by creative motive; derives tickers; holds the borrowed hometown pins |
| `app/graph/pepl/PeplGraph.tsx` | the scene (~1500 lines): camera, bubble body, choreography, chrome |
| `app/graph/pepl/tokens.css` | **load-bearing.** Aliases pepl's `--font-jakarta`/`--cream`/`--ink` onto our `--usp-*`. The canvas reads these at runtime via `getComputedStyle` because `ctx.font` cannot resolve `var()`. Without it the sheet draws with no typeface. |
| `app/graph/GraphLab.tsx` | the OLD force-graph room, kept not deleted — it owns the receipts UI worth lifting across |

## Open work, roughly in priority order

1. **Pop the bubble on double-click** — `poppedRef`/`popped` state exists in
   `PeplGraph.tsx` and `camHome()` already honours it (unpopped = fit the room
   inside the lens; popped = release to full size). The dblclick handler and
   hiding the bubble are **not wired**.
2. **Zoom out of focus** on a person's dot (currently only click-empty releases).
3. **Search → zoom to name** with the bubble parked in a corner. The bubble home
   target is already zoom-dependent (top-left past 1.25×); search just needs to
   drive the camera.
4. **"People you should meet" window** beside the stamps — the ranked
   connections list from the old panel (`GraphLab.tsx`, `ConnButton`).
5. **Line connections between people** + a **restyled legend** for them (square
   corners, sentence case, film hues).
6. **Monet filter above everything** — the ticker, hometown map, buttons and logo
   are DOM siblings *outside* the WebGL canvas, so the in-shader pass can't reach
   them. Needs either a full-bleed overlay canvas or moving those widgets into
   the composited layer.
7. **Group story** — each group has three unused layers: `asp` (what they do),
   `mission` (what they'd change), `impact` (how it lands). e.g. craft-obsession
   is 51 people, mostly design/directing, most want to build community. **Caveat:
   sparse** — only ~21 of 51 have a mission. Any subtitle must say "most of those
   who said", never imply all.
8. Ticker connector curves removal; more school/company logos (26 shipped in
   `public/logos`, gated on file existence via `LOGO_SLUGS`).

## Things to know before editing

- **The 26 motive-less guests are folded by mission**, not assigned a motive.
  It is a layout placement only — nothing renders a motive for them, and nothing
  should start to. `adapter.ts` says so at the source.
- **Stamps are thin**: `graph.json` carries title/school/company/motive but not
  `hometown`/`instagram`/`favorite`. Those live in `public/graph/people/*.json`
  and `data/graph-enriched.csv` and need fetching on focus.
- **The belief stamp's "you both believe" is outlined art, not a slot** in our
  `passport/document/assets.gen.ts`. pepl's copy adds a `CHANGE_small` slot; the
  ported `app/graph/pepl/stamps/assets.ts` has it. Only put a fact in that card
  when the sentence is literally true.
- **Hometown pin coordinates were borrowed from the pepl build** (same guest
  list, geocoded there). Our pipeline bakes the hometown string but no lat/lng.
- `.env` exists locally and is gitignored. Aura was live (1975 nodes) and the
  Butterbase gateway works, but `BUTTERBASE_EMBED_MODEL` points at a
  titan-embed model **that is not on the gateway** — use `EMBED_PROVIDER=tfidf`.
