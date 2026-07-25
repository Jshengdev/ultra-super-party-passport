# Party Graph v2 — design spec

**Date:** 2026-07-25 · **Status:** awaiting user review
**Source:** the real Luma export `LA INTERN PARTY - Guests - 2026-07-23-06-16-26.csv`
(364 rows → 325 approved). Vision: Johnny. Baseplate design: existing Universe language
(Teri's tokens). Built under THE LAWS in `CLAUDE.md`.

## 1. Summary

A new precomputed social-graph surface over the real guest list: **three focused tabs**,
each carrying a distinct class of relationship, plus a per-person spotlight with
receipt-backed highlights. All computation happens once at build time through the
existing full pipeline (ontology gate → Neo4j → gateway/pipe); the surface reads two
baked JSON artifacts and is statically exportable. No new npm dependencies. No new
visual system — the existing warm-paper / spectrum-dot / mono-stamp language is the
baseplate.

**Decisions already made (with Johnny):**
- Full pipeline, not a standalone script (laws a–d apply to every write and LLM call).
- Keep the baseplate front-end design; no new design direction.
- Max 3 tabs, chosen for information value; map + 3D depth tabs are cut, their unique
  facts move to the person card.
- All 12 computed insights in the first precompute run.
- Approved guests only (325); `pending_approval`/`invited` excluded; approved guests
  with missing fields are placed and flagged, never guessed.

## 2. Source of truth

The CSV is the only source of people, schools, companies. Columns used: `guest_id`,
`name`, `email`, `created_at`, `approval_status`, `checked_in_at`, company, job title,
hometown, Instagram, school, .edu email, favorite movie/show, and four free-text
answers: *what drew you*, *ultimate goal*, *looking to connect with*, *biggest
inspiration*. `personId` = email-localpart slug (same rule as passports:
`personIdFor`).

**Privacy rule (new — this export, unlike the last one, carries real emails and
phone numbers):** the raw CSV is NOT committed; it is read from a local path
(`GUESTS_CSV` env, gitignored if copied into `data/`). Emails and phone numbers are
build-time inputs only — no emitted artifact (`data/graph/*`) contains an email,
phone number, `.edu` address, eth/solana address, or QR check-in URL. Instagram
handles are kept (guests shared them for exactly this surface).

Known data hazards the normalizer must handle: 73 guests wrote "creative" as company
(→ `isFreelance: true`, never a shared employer); duplicated names
("Vianne NguyenVianne Nguyen"); first-name-only guests; class-year suffixes on schools;
alias soup (NBCU/NBCUniversal, LA/Los Angeles, dual hometowns "LA/Beijing").

## 3. Architecture — four stages, one command

`npm run graph:build` (new) runs A→D. A 13-person **golden sample**
(`GUESTS_FILTER=<ids>`) runs the identical path end-to-end for eyeball review before
the full 325 run.

### Stage A — Normalize (`scripts/normalize-guests.ts`)
Deterministic first: trim/casefold, strip class years, split dual hometowns
(primary + secondary), collapse duplicated names, alias tables for the big entities,
freelance flag. Then ONE batched guarded LLM pass (gateway, zod) that maps residual
variants **into the candidate set extracted from the sheet** — the guard rejects any
entity not present in the data (grounding-by-construction, law a applied to entity
resolution). Missing/unclear fields for approved guests → `flags: ["missing-school"]`.
Output: canonical rows (in-memory + `data/graph/normalized.json` for auditability).

### Stage B — Graph writes (`scripts/ingest-guests.ts`)
All through `dispatch()` — zero raw Cypher. Ontology extensions to
`ontology/manifest.ts`:

- New labels: `Place { name, lat, lng, region }`, `Inspiration { name }`.
- New links: `Person-FROM->Place`, `Person-INSPIRED_BY->Inspiration`,
  `Person-SEEKS->Person { score, mutual, via, your_field, their_field }`,
  `Person-ASPIRES_TO->Company { quote }`.
- New ACTIONS: `ingest_guest_v2` (the richer row), `write_place`, `write_seek_edges`,
  `write_inspirations`. Existing `Company`/`WORKS_AT` (allowlisted, currently unused)
  gets populated. Existing `check_in` untouched.
- Provenance on everything: `{_src: "csv:la-intern-party" | "gateway:<leg>", _ts, _actor}`.
- `scripts/check-conformance.ts` must still return 0 violations.

### Stage C — Enrichment (`scripts/enrich-graph.ts`)
Gateway budget ≈ 650 embedding items + ~40 batched chat calls, all guarded
(validate → retry once → fail loud; DEGRADED with named error if creds missing):

- Embeddings: `goal` and `seeking` texts for all 325.
- Clusters: app-side k-means on goal embeddings (no GDS) + guarded naming
  (≤3 words, space-vocabulary blocklist).
- Layouts: seeded force layout (Web), 2D projection of goal embeddings (Currents),
  Exchange orderings — baked per person so tabs never re-simulate.
- The 12 insights (§6), each with its computation recipe and guard.
- `storyline`: ≤8-word distilled line per person (guarded: key nouns must appear in
  their own answers — same rule as the existing `whyGuard`).

### Stage D — Emit (`scripts/generate-graph.ts`)
- `data/graph/graph.json` — nodes (typed, cluster-hued, positioned per tab), typed
  edges with receipts, cluster stamps, meta counts.
- `data/graph/people/<personId>.json` — the per-person record (§5).
- `scripts/audit-graph-receipts.ts` — every edge receipt and every highlight must
  resolve against the graph AND against the verbatim CSV text; the audit can FAIL
  (law c). Wired into `verify:goal` as a new leg.

## 4. The three tabs (`app/graph/` — new route, `/universe` untouched)

Tab chrome is minimal baseplate: a hairline rule under the header, three mono
small-caps entries, active entry underlined with the existing 4-stop spectrum
gradient (framer-motion layoutId slide), keys 1–3. Reuses `passport/tokens.css`
via the same per-route import; canvas reads tokens via `getComputedStyle`
(never invents a hex). Statically exportable: no dynamic API, no query params —
the page reads the baked JSON.

**1 · THE WEB — institutional ground truth.** `react-force-graph-2d`, existing dot
grammar (flat cluster-hued r≈5 dots, ink hairline ring, degree sizing capped, quiet
neutral hubs with counts painted inside, existing progressive-disclosure zoom
thresholds). Edge grammar: school = solid 1px hairline; company = dashed [2,3];
came-together clique edges = short-dash faint (from signup-wave detection).
Freelancers get a legend-explained mark and no company edge. Second line under each
name is the `storyline`, mono, faint. Bridge-people betweenness feeds node size.

**2 · CURRENTS — aspirational resonance.** Precached 2D positions; people at their
goal-embedding coordinates; tilted mono cluster stamps with counts at density peaks.
Doppelgänger + rare-phrase echo edges render only in spotlight. Bottom caption strip
(surface at ~82% + blur, hairline top rule) retypes the hovered person's verbatim
goal in the existing serif-italic belief voice with a mono attribution. Optional
overlay chips: inspiration lineages (Miyazaki table, the Mom Caucus).

**3 · THE EXCHANGE — transactional demand.** The directed seeking↔offering view.
Demand/supply bars per role (market report) across the top in mono. People grouped
by what they OFFER; directed edges drawn as tapered strokes (thick at seeker → thin
at sought; taper + travel direction replace arrowheads). Mutual matches are the hero
layer, drawn double-tapered and listed first. Selecting yourself splits inbound
("PEOPLE LOOKING FOR SOMEONE LIKE YOU · N") from outbound, inbound capped top-8
ranked. Below-threshold matches stay bundled at category level — never a fabricated
person-level claim.

**Spotlight (all tabs, one grammar).** Search reuses the existing sine-wave
spectrum-gradient letters; selection dims everything outside the ego-web to alpha
0.12 (existing motif). Edges illuminate ranked with numbered mono via-labels
("01 · USC", "02 · WANTS TO DIRECT", "03 · LOOKING FOR EDITORS"), each clickable
into its receipt. Selection persists across tab switches. The person card shows
`storyline`, canonical fields, and the `highlights` list (§5).

**Receipt card (the load-bearing interaction).** Click any edge → a DOM card
(surface, radius-lg, shadow-panel): both people's verbatim sheet text side by side,
question labels in mono small-caps, the overlapping phrase highlighted in the edge's
cluster hue at low alpha in BOTH quotes (spans come from the echo miner — never
regenerated at view time), and a mono provenance footer:
`src · sheet rows 118 + 214 · SEEKS · cosine 0.87 · receipt resolved ✓`.

## 5. Per-person record — `data/graph/people/<personId>.json`

```jsonc
{
  "personId": "tjalloh", "guestId": "gst-…", "name": "TJ Jalloh",
  "storyline": "actor learning the agency side",        // guarded, receipt-backed
  "canonical": {
    "company":  { "id": "company:aefh", "display": "AEFH Talent Agency", "raw": "…" },
    "isFreelance": false,
    "title":    { "display": "Intern", "role": "actor", "seniority": "intern" },
    "school":   { "id": "school:vanderbilt", "display": "Vanderbilt", "classYear": 2028 },
    "hometown": { "id": "place:newark-nj", "display": "Newark, NJ", "lat": 40.7, "lng": -74.2 },
    "instagram": "…"
  },
  "flags": [],                                          // flagged, never guessed
  "answers": { "goal": "…", "drew": "…", "seeking": "…", "inspiration": "…", "favorite": "…" },
  "semantic": { "cluster": { "id": "…", "label": "…" },
                "pos": { "web": [x,y], "currents": [x,y], "exchange": { "group": "…", "index": n } },
                "gradient": { "stops": [] } },
  "edges": [   // ranked; EVERY edge carries its receipt
    { "targetId": "…", "type": "school|company|seeking|doppelganger|echo|clique|aspiration|inspiration|taste|future_self",
      "direction": "mutual|outbound|inbound",           // seeking-family only
      "strength": 0.93, "via": "…",
      "receipt": { "yours": {"field": "…", "quote": "…", "span": [a,b]},
                   "theirs": {"field": "…", "quote": "…", "span": [a,b]} } }
  ],
  "highlights": [  // person-card facts (absorb the cut tabs' information)
    { "kind": "sought-by",   "text": "2 people tonight are looking for someone like you", "targets": ["…"] },
    { "kind": "only-one",    "text": "the only person here from Newark" },
    { "kind": "demand-ratio","text": "you want to edit — demand is 4:1" },
    { "kind": "diaspora-twin","text": "…", "targets": ["…"] },
    { "kind": "concierge",   "text": "reach her through Jordan (USC)", "path": ["…","…"] },
    { "kind": "door",        "trigger": "checkin", "pairId": "…", "template": "…" }
  ]
}
```

Verbatim answers travel inside the record so every receipt resolves without a second
lookup. Canonical ids are namespaced like the existing graph (`school:`, `company:`,
`place:`).

## 6. The 12 insights (all in run one)

| # | Insight | Recipe (summary) | LLM? | Surfaces at |
|---|---|---|---|---|
| 1 | Reciprocal seek match | asymmetric cosine matrix seek×offer, both directions survive threshold | via-phrase only, guarded | Exchange hero |
| 2 | Semantic doppelgänger | nearest goal-neighbor sharing NO school/company/hometown/clique | no | Currents spotlight |
| 3 | Rare-phrase echo | shared 3–6-word n-grams, corpus df≤3 → receipt highlight spans everywhere | no | receipt engine + Currents |
| 4 | Signup-wave cliques | created_at burst clustering + shared-attribute confirmation | no | Web (clique edges) + exclusion filter for #1–#2 |
| 5 | Market report | seeks+offers classified onto ~12-role taxonomy → demand/supply per role | one batched pass, zod-enum | Exchange bars + card |
| 6 | Only-one-here | singleton/superlative counting on normalized fields (+haversine vs vendored city table) | canonicalization only | person card |
| 7 | Concierge path | Neo4j weighted variable-length paths (≤3 hops) to top-3 targets, path_receipt per hop | no | spotlight card |
| 8 | Future-self edges | goal-role of A == current title-role of B (from #5's taxonomy) | no | Exchange layer |
| 9 | Bridge people | app-side Brandes betweenness on composite graph | no | Web node size + filter |
| 10 | Door-moment triggers | precached pairs × live checked-in flags (existing check-in state; zero view-time inference) | no | toast, all tabs |
| 11 | Diaspora twins | same non-LA hometown metro ∧ (goal-cosine high ∨ same role) | no | person card |
| 12 | Inspiration lineage + taste twins | canonicalize inspirations (alias-merge guard); exact favorite-title matches; optional title→{genre,tone} against fixed vocab, provenance-marked model-enriched | canonicalization + fenced enrich | Currents overlay + card garnish |

Every LLM output is validated, retried once, then fails loud; nothing silently
falls back (law b). Model-asserted world knowledge (#12 tier 2) is provenance-marked
`model-enriched` and fenced to a controlled vocabulary.

## 7. Error handling & degraded mode

- No Neo4j/gateway creds → named errors (`Neo4jNotConfigured`, `GatewayNotConfigured`),
  exit 2, DEGRADED — never a fake answer.
- Normalizer LLM guard failure after retry → row keeps deterministic-only
  normalization + a `flags` entry; the run reports every guard failure at the end
  and exits non-zero if any receipt would not resolve.
- The frontend renders whatever `graph.json` says and nothing else; a missing
  `people/<id>.json` renders a visible FAILED state, not a blank.

## 8. Verification

1. **Golden sample first**: the 13-person sample end-to-end; Johnny eyeballs the
   records and receipts before the 325 run.
2. `npx tsc --noEmit` clean; zod at every boundary.
3. `scripts/check-conformance.ts` — 0 off-ontology labels/rels, 0 missing provenance.
4. `scripts/audit-graph-receipts.ts` — every edge, highlight span, and highlight
   fact resolves; must be able to FAIL.
5. Static export still builds (`STATIC_EXPORT=1`); `/universe`, `/passport/*`,
   check-in flow untouched (G2/G5 gates still pass).

## 9. Out of scope

Map tab, 3D/depth tab, three.js or any new dependency, live view-time inference,
Instagram scraping, any use of pending/invited guests beyond the excluded-count
caption, changes to Teri's existing token values (additions only, flagged for her).

## 10. Open items

- Route name: `/graph` (default) — rename freely.
- `storyline` copy tone: worth a pass with Teri once the golden sample exists.
- Tab names (THE WEB / CURRENTS / THE EXCHANGE) are placeholders for the same review.
