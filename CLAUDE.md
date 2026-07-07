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

## Window ownership map

| Window | Owns | Goals |
|---|---|---|
| **build-loop** | `ontology/manifest.ts`, `lib/ontology-gate.ts`, `lib/neo4j.ts`, `lib/gateway.ts`, `scripts/gen-test-csv.ts`, `scripts/ingest.ts`, `scripts/check-conformance.ts`, `scripts/check-values.ts`, `pipeline/*.pipe`, `data/test-party.csv` | G3 values · G4 ingest · G5 check-in action |
| **passport** | `passport/schema.ts`, `passport/*.ts` (generator), `scripts/generate-passports.ts`, `scripts/audit-receipts.ts`, `data/passports/` | G1 passport |
| **frontend** | `app/universe/`, `app/api/*`, `app/page.tsx`, `app/globals.css`, `passport/tokens.css`, `scripts/check-universe.ts`, `scripts/check-checkin.ts` | G2 universe · G5 check-in UI |
| **story** (this window) | `CLAUDE.md`, `README.md`, `docs/DEMO-SCRIPT.md`, `docs/SUBMISSION.md`, `scripts/check-ship.ts` | G6 ship |

Shared shapes (code against these EXACTLY): see `gx/goals/usp-v1.md`. CSV columns, ontology object
types, link-type allowlist, passport JSON, and ACTION types are all pinned there.

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

**House rules:** TS strict; zod at every boundary; fail loud with named errors; deterministic guard
around every LLM call. Deps are installed — do NOT touch `package.json`, `.env*`, or `.git`.
