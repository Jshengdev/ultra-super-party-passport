# Ultra Super Party Passport — project brain

**What this is.** The Universe + Passport for Micah's LA intern party (7/18). Everyone signs up
through a Luma-style form (the CSV fields + ONE question: *"what do you think it means to be
creative?"*). Signups flow through a **deployed pipeline** into a **typed relational graph**
(school / major / company / what-they-do + how their beliefs align). Two surfaces come out of the
graph: a clean, NOT-space-themed **Universe** where value-clouds glow, and a per-person
**Passport** — the two people you should find tonight and *why* (one same-work, one same-values),
a hidden scavenger prompt, a **magic inference** (something they never told us — "how does it
know?"), and a gradient generated from who you are. Check in at the door → the graph shifts state
→ the passport updates. Everything on the passport is purely relational: extracted from real graph
paths, with receipts. **This is our HackwithBay 3.0 entry** (slug `HackwithBay-0707`).

Vision: Johnny. Design: Teri. Distribution + DNA-gradient: Sarah. Built live by the gx AI lab.

---

## THE LAWS (non-negotiable — from the gx corpus: dot / sayhello / pepl)

- **(a) The ontology gate is the only write path.** Every write goes through `lib/ontology-gate.ts`:
  validate against `ontology/manifest.ts` (zod) → parameterized Cypher → provenance props. Off-ontology
  labels/rels are **unrepresentable** — the agent cannot hallucinate a node type (pepl:
  grounding-by-construction). No raw driver writes anywhere else.
- **(b) Every LLM call is wrapped by a deterministic guard.** Validate the output shape, reject +
  retry once, then **fail loud**. FAILED states are visible, never a silent fallback
  (sayhello fail-closed law). No creds → **DEGRADED mode** with a named error, never a fake answer.
- **(c) Every passport claim carries a `path_receipt` that must resolve.** A `why` with no edge behind
  it is a bug. The receipts audit (`scripts/audit-receipts.ts`) can and must be able to FAIL
  (dot grounded-counts: never invent, prove by re-reading the graph).
- **(d) Provenance on every write.** `{_src, _ts, _actor}` props on every node and rel — "why is this
  here" is always answerable.
- **(e) The contract is `gx/goals/usp-v1.md`.** Report EVERY departure as
  `[good|neutral|bad] where — what + why`. Never silently average two readings.
- **(f) Design: NOT space themed** (no planets/stars — "that's ugly"). Clean, glass-orb / spectrum
  direction. Design tokens live in `passport/tokens.css` and are **Teri's handle** — don't fight them.
- **(g) Stay in your window.** Ownership map below. Import across windows ONLY from the declared shared
  surface: `ontology/manifest.ts`, `passport/schema.ts`, `lib/neo4j.ts`, `lib/gateway.ts`.

---

## Code map (current — the hackathon window split is retired)

| Area | Files | What it is |
|---|---|---|
| **Laws' machinery** | `ontology/manifest.ts` (labels/links/ACTIONS + Cypher), `lib/ontology-gate.ts` (`dispatch()` — the ONLY write path), `lib/neo4j.ts`, `lib/gateway.ts` (guarded `chat`/`embed`) | shared surface — change with extreme care |
| **v1 pipeline** | `lib/ingest.ts`, `scripts/precache.ts`, `scripts/ingest.ts`, `lib/cluster.ts`, `scripts/extract-interests.ts`, `pipeline/*.pipe` | hackathon population (193) → passports |
| **Passports** | `passport/schema.ts`, `lib/passport.ts`, `lib/traverse.ts`, `scripts/generate-passports.ts`, `scripts/audit-receipts.ts`, `data/passports/` | per-person receipted JSON |
| **v2 pipeline** | `lib/guests.ts` → `scripts/ingest-guests.ts` → `lib/conviction.ts`/`scripts/enrich-convictions.ts` → `lib/matches.ts`/`scripts/enrich-matches.ts` → `lib/layout.ts`/`scripts/emit-graph.ts` → `public/graph/*` | real guest list (312) → baked graph artifacts |
| **Surfaces** | `app/page.tsx` (CSV-drop landing), `app/universe/` (the room), `app/graph/` (the room re-fed: drag-in entry via `app/graph/verify.ts`, panel, receipts), `app/passport/[id]/`, `app/deck/`; `passport/tokens.css` = design's handle (canvas reads tokens live, never invents a hex) | what people see |
| **Gates** | `scripts/check-conformance.ts` · `check-guests.ts` · `check-graph-{ontology,emit,entry,e2e}.ts` · `audit-graph.ts` (fail-able receipts audit) · `check-universe/checkin/values/ship.ts` · `verify-goal.sh` | what green means |

Pinned shapes: `gx/goals/usp-v1.md` (v1 contract) + the as-built departure report at the end of
`docs/superpowers/specs/2026-07-25-party-graph-design.md` (where v2 deviates, and why).

## Docs (routing only — each exists to save search time; the code is the understanding)

`README.md` story + architecture · `docs/SUBMISSION.md` hackathon entry (ship-gate required) ·
`docs/DEMO-SCRIPT.md` 60-second demo runbook (v1-era; refresh with the real-party numbers) ·
`docs/POSITIONING.md` shareable hand-off copy · `docs/BUTTERBASE.md` hosting/gateway operator
runbook · `docs/ROCKETRIDE.md` pipe deploy runbook · the spec above = v2 as-built record.
Nothing else; new knowledge goes into code comments or a line here.

## The dataset schema + optimization loop (the node-tuning workflow)

- **Graph nodes/edges**: `ontology/manifest.ts` is the schema — labels, links, and every write's
  Cypher live there; nothing off-manifest can exist.
- **The sheet**: `data/graph-enriched.csv` — one row per person, every computed field visible
  (identity · conviction tags + verbatim quotes · hubs/groups · top-5 matches · doppelgänger).
  Column contract + override rules are documented where they execute: the header comment in
  `scripts/emit-graph.ts`.
- **The loop**: edit `data/graph-overrides.csv` (sparse: person_id + any of motive/mission/impact/
  aspiration/pinned_match/hide/host_notes) → re-run emit + gates (commands above) → refresh the
  room. Off-vocabulary tags fail loud; quotes are never overridable; overridden fields carry
  `_overridden` provenance. A real `hide` must update `EXPECTED_PEOPLE` in the same commit.

## Working here with an agent

1. Read this file; the laws above bind every change. Rationale lives in constraint comments at the
   source — read the code, don't look for side docs (and don't write new ones; a few lines HERE at most).
2. Branch off `master`; small diffs; `git add` only your files (never `package.json`, `.env*`, `out/`,
   `public/graph/` unless you re-baked it through the pipeline).
3. Every change keeps its gates green (table above + `npx tsc --noEmit`); data/copy changes re-run
   `emit-graph` → `check-graph-emit` → `audit-graph` — the audit re-derives every count and quote, and
   a red audit is a real defect, not a flaky test.
4. LLM work: through `lib/gateway.ts` only, zod-guarded, retry once, fail loud; new node/edge types
   enter through `ontology/manifest.ts` or they are unrepresentable.
5. PR against `master`; report departures from pinned shapes as `[good|neutral|bad] where — what + why`.

---

## The stack (all three MANDATORY — deep-integration or DQ)

- **Butterbase** — backend (db + auth) + the OpenAI-compatible **AI gateway** (one `bb_sk_` key,
  base_url override) + the deploy target + the **MCP submission venue**. Every LLM/embedding call
  routes through the gateway, never a direct provider SDK.
- **Neo4j Aura Free** — the ontology property graph the agent **actively traverses** (Cypher /
  variable-length paths / relationship retrieval). NOT a KV store. No GDS on Free → clustering is
  app-side; enforcement is at the gate, not DB constraints.
- **RocketRide** — the ingest/inference `.pipe` **deployed to cloud.rocketride.ai** = the inference
  path the app calls (`POST /task/data`, `Authorization: Bearer`). Local/Docker does NOT satisfy.
- **Cognee** (bonus) — agent memory, OSS + Neo4j backend. Wire only after mandatories are green.
  **Daytona** (bonus) — sandbox; skip unless a code-run surface is already on the demo path.

## Env contract (read from `process.env`, NEVER hardcode; DEGRADED mode without creds)

```
NEO4J_URI  NEO4J_USERNAME  NEO4J_PASSWORD  NEO4J_DATABASE
BUTTERBASE_API_KEY  BUTTERBASE_GATEWAY_URL
ROCKETRIDE_URI  ROCKETRIDE_APIKEY
LIVE_URL          # the deployed Butterbase URL — read by scripts/check-ship.ts (also accepts
                  # NEXT_PUBLIC_LIVE_URL / BUTTERBASE_LIVE_URL). NOT yet in .env.example.
```

## Commands

```
npm run dev          # next dev — the Universe + passport surfaces
npm run gen:csv      # synthesize the ~40-creative test CSV → data/test-party.csv
npm run ingest       # CSV → ontology-gated graph (through the deployed .pipe / gateway)
npm run passports    # agent traverses the graph → data/passports/<personId>.json
npm run verify:goal  # the usp-v1 goal gate (per-leg: ingest values passport universe ship all)
npx tsx scripts/check-ship.ts   # the G6 ship checklist (submission + repo + live URL + .pipe + passports)
npx tsc --noEmit     # TypeScript strict — fix YOUR files' errors before finishing
```

**Graph v2 (/graph, real guest list)** — the surface reads committed `public/graph/*`, so
`npm run dev` + design work need NO creds; `passport/tokens.css` hot-recolors both rooms.
Pipeline/gates (tsx does NOT autoload .env — `set -a; source .env; set +a` first):
`GUESTS_CSV=<luma export path>` `EMBED_PROVIDER=tfidf` (gateway has no embedding models
anymore) `CONVICTION_MODEL=anthropic/claude-haiku-4.5`; then `scripts/ingest-guests.ts` →
`enrich-convictions.ts` → `enrich-matches.ts` → `emit-graph.ts`, gated by
`check-graph-{ontology,emit,entry,e2e}.ts` + `audit-graph.ts` (receipts audit — can FAIL).
Aura auto-pauses when idle ("no routing servers" = asleep). Everything else: read the code.

**House rules:** TS strict; zod at every boundary; fail loud with named errors; deterministic guard
around every LLM call. Deps are installed — do NOT touch `package.json`, `.env*`, or `.git`.
