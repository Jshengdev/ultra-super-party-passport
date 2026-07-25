# Design Playbook — tinkering with the room

For Teri (and anyone restyling the party surfaces). This is the working loop: run it,
change how it looks, see it instantly, and know which gates keep you safe. No pipeline
knowledge required for visual work.

---

## 1 · Run it (two minutes, no credentials needed)

Visual work needs zero secrets — the graph data is baked into the repo.

```bash
git checkout feat/party-graph-v2   # (or master once merged)
npm run dev
```

- **`/universe`** — the original room (193-person hackathon population).
- **`/graph`** — the new room (312 real guests). First visit shows the drop zone:
  drag the party CSV onto it (parsed in your browser, never uploaded) or press
  **skip →**. After the first visit it goes straight to the graph.
- If the terminal says port 3000 is busy, it auto-moves (watch for the URL, e.g. :3001).

## 2 · Where the design lives — your handles, strongest first

### `passport/tokens.css` — THE handle (owned by design)

Every color, radius, shadow, and type step on both rooms. The canvases read these
**live** via `getComputedStyle` — edit a token, refresh the browser, the entire room
recolors. No rebuild, no pipeline, no code.

| Token family | What it drives |
|---|---|
| `--usp-bg / -canvas-bg / -surface / -surface-2` | paper, canvas bed, cards/panels |
| `--usp-ink / -ink-muted / -ink-faint / -border` | text tiers, hairlines |
| `--usp-spectrum-0 … -7` | the palette everything colorful hashes into — people's hues, cluster colors, the rainbow hairline. **Contract: add or remove stops freely**; the code loops whatever `--usp-spectrum-N` exist and hashes into them. |
| `--usp-radius-sm/-md/-lg/-pill` | corner language |
| `--usp-shadow-panel / -soft` | elevation |
| `--usp-font-sans / -serif` (+ mono via globals) | names / verbatim quotes / stamps & labels |

(`passport/document/tokens.css` is a separate system for the passport document + deck —
different world, don't cross the streams.)

### Module CSS — the page furniture

- `app/universe/universe.module.css` — original room's shell (header, rainbow hairline,
  cover-band blooms, legend, glass panel, chips).
- `app/graph/graph.module.css` — new room's shell (mirrors the same anatomy).

Spacing, blur, panel widths, the drop-zone look, beat typography — all here, all
hot-reloading.

### Canvas paint code — the deepest layer (numbers, not colors)

Dot radii, ring widths, zoom thresholds for when names appear, stamp tilt:
`app/universe/UniverseGraph.tsx` and `app/graph/GraphLab.tsx` (constants near the top
of the paint code). **The one hard law** (`app/universe/lib/palette.ts` states it):
canvas code never invents a hex — every color is read from your tokens. If you want a
new color anywhere, it enters through `tokens.css`, which keeps every surface coherent.

## 3 · What is data, not design (don't hand-edit)

`public/graph/graph.json` and `public/graph/people/*.json` are **baked and audited**
artifacts — every count re-derived, every quote byte-checked against the guest sheet.
Hand-editing them will fail the audit. Two consequences:

- **Wording of the computed facts** ("One of 9 here to preserve stories", "2 people are
  looking for someone like you") is a *template* in `scripts/emit-graph.ts` — change the
  phrasing there, then re-bake (§4). House copy law: person-facing facts are
  positive-or-neutral; zero-counts never render; a claim's number must stay derivable
  (the audit re-counts every one).
- Everything else on screen (colors, sizes, spacing, motion) is design and never needs
  a re-bake.

## 4 · Re-baking (only when templates/data change — needs `.env` from Johnny)

`tsx` does **not** auto-load `.env` — source it first, always:

```bash
set -a; source .env; set +a
export GUESTS_CSV="$HOME/Downloads/LA INTERN PARTY - Guests - 2026-07-23-06-16-26.csv"
export EMBED_PROVIDER=tfidf CONVICTION_MODEL=anthropic/claude-haiku-4.5

npx tsx scripts/emit-graph.ts         # re-bake public/graph from the live graph
npx tsx scripts/check-graph-emit.ts   # artifact gate (PII tripwire, dignity floor)
npx tsx scripts/audit-graph.ts        # receipts audit — must stay green
```

Full pipeline from a fresh CSV export (rarely needed): `ingest-guests.ts` →
`enrich-convictions.ts` → `enrich-matches.ts` → the three commands above. The Neo4j
Aura instance auto-pauses when idle — if conformance says "no routing servers," it's
asleep (Johnny can wake it via the Aura console/API).

## 5 · Before you commit — the safety net

```bash
npx tsc --noEmit
GUESTS_CSV="…same path…" npx tsx scripts/check-graph-entry.ts   # the drop-zone gate
# plus check-graph-emit + audit-graph IF you re-baked
```

Green = you broke nothing that matters. PR against `master`.

## 6 · The map

| Touch freely | Touch carefully | Don't touch |
|---|---|---|
| `passport/tokens.css` | canvas paint constants (keep the token law) | `public/graph/*` by hand |
| `universe.module.css`, `graph.module.css` | copy templates in `emit-graph.ts` (re-bake + audit after) | `ontology/manifest.ts`, `lib/ontology-gate.ts` (the write laws) |
| legend/label copy in the components | `app/graph/verify.ts` (has its own gate) | `.env`, `package.json` |

Design intent, for reference: **NOT space themed** — warm paper, glass, spectrum;
every visual channel encodes something real (hue = why they create, size = how
connected, stamps = shared convictions); nothing decorative, everything receipted.
