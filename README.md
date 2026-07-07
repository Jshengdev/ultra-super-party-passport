# The Ultra Super Social Passport™

**Live:** [ultra-super-party-passport.butterbase.dev](https://ultra-super-party-passport.butterbase.dev) ·
**Deck:** [/deck](https://ultra-super-party-passport.butterbase.dev/deck) ·
**Positioning:** [/positioning.html](https://ultra-super-party-passport.butterbase.dev/positioning.html) ·
**Demo video:** [Drive](https://drive.google.com/drive/folders/1DDGzIAD0a9tTNt1ZJwswI6IPLzXwfc9H?usp=drive_link)

**193 guests · 6 value clouds · 3,133 shared-value ties · 164 distilled interests · 193 passports · 0 unreceipted claims**

**Sign up to a party, and a passport writes itself** — the two people you'd click with tonight and one
thing it somehow knew about you. It's **relational, not a knowledge graph** (it connects people, not
your tags), and the AI is completely **invisible**.

Our HackwithBay 3.0 entry (submitted — entry `d7a73662`, v3). Built for a real event: an LA intern
party for creatives (7/18), running on the party's REAL 193-guest list. Everyone signs up through a
Luma-style form with one extra question — *"what do you think it means to be creative?"* — and gets
back a personalized passport: the two people to find (one who shares your work, one who shares your
values, each with a receipted reason), a hidden scavenger prompt, a **magic inference** (something you
never typed — "how does it know?"), and a gradient generated from who you are.

**The full experience:** drop the guest CSV → the analysis plays (every number parsed live from the
file) → the room: a paper-white relational map where each person wears their value cloud's color,
shared interests bridge the clouds as amber touchpoints, and hubs are sized by the people they hold →
type your name (the matched name waves in gradient on the map) → *I'm going* → **Generate my
passport** → the cover flips open: Teri's document with foil tilt + holo sheen, stamps, the MRZ line —
plus a sketch-your-headshot frame (the brush ink IS the brand gradient) and a QR that puts your
passport on your phone.

---

## The story in one breath

Underneath the party toy is a thesis we've been building for a year: **AI as an honest mirror** — a
tool that reflects a true perspective back so you can make better choices. The passport is the smallest,
most fun version of that mirror: it tells you who you are by telling you who, in this room, you'd click
with and why. And it stays invisible on purpose — the moment you say "AI," people flinch and stop
sharing. So there's no chatbot. You fill a form; you get a gift.

## Stack

Three integrations are load-bearing (deep-integration or it doesn't count):

```
  Luma-style sign-up form
          │  name · school · major · what_you_do · working_on · belief_creative
          ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  RocketRide  ── deployed .pipe (cloud.rocketride.ai) ─────────│  the INFERENCE PATH
  │  the app POSTs sign-ups here; the pipe runs ingest/inference  │  (deployed, not local)
  └───────────────────────────┬──────────────────────────────────┘
                              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Butterbase  ── backend + auth + OpenAI-compatible AI gateway │  the BRAIN + BACKBONE
  │  every LLM/embedding call routes through the gateway          │  (one bb_sk_ key)
  │  deploy target · submission via Butterbase MCP                │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼  writes ONLY through lib/ontology-gate.ts (validate → Cypher → provenance)
  ┌──────────────────────────────────────────────────────────────┐
  │  Neo4j Aura  ── the typed ontology property graph            │  the RELATIONAL LAYER
  │  Person→Person edges (WORKS_ON, SHARES_VALUE); traversed,     │  (a graph, not a KV store)
  │  not stored. off-ontology writes are unrepresentable.         │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼  agent traverses real paths → path_receipts
      ┌───────────────────────┴───────────────────────┐
      ▼                                                ▼
  /universe  (the glowing relational map)      data/passports/<personId>.json
                                               (2 people to find + why · magic line · gradient)
```

## Architecture, in detail

**The data flow, end to end:**
`Luma CSV → precache (normalize + enrich) → ontology-gated ingest → Neo4j property graph →
typed traversal → passport JSON (receipted) → static build (graph + 193 passport pages baked) →
Butterbase CDN`

### 1 · The frontend (Next.js 15 · React 19 · TypeScript strict · Tailwind 4 · framer-motion)
App Router throughout. The deploy is a **static export** (`output: 'export'`): every React page —
including all 193 passports via `generateStaticParams` — pre-renders to HTML at build, then hydrates
client-side. `/api/graph` is a route handler that runs live Cypher at build time, so **the graph
snapshot is baked into the bundle** (the "invisible precache" — the analysis page replays real,
pre-computed work with numbers parsed live from the dropped file). Surfaces: `/` (analysis theater),
`/universe` (force-graph canvas: color = value cloud, amber = shared interests, hub size = people
held, always-animating gradient wave on matched names), `/passport/[id]` (Teri's document: foil tilt,
holo sheen, sketch frame, QR), `/deck` (Teri's React slide system).

### 2 · The ontology + the gate (Neo4j Aura · `ontology/manifest.ts` · `lib/ontology-gate.ts`)
One zod manifest is the single source of truth: object types (`Person, School, Major, Activity,
Belief, ValueCluster, Interest, Party, Company`), a **patterns allowlist** of legal
`(subject)-[REL]->(object)` triples (`STUDIES_AT, MAJORS_IN, WORKS_AT, DOES, WORKING_ON, BELIEVES,
IN_CLUSTER, SHARES_VALUE, INTERESTED_IN, SIGNED_UP`), and **typed ACTION definitions**
(`ingest_person, write_value_cluster, write_interests, check_in`) — each a zod schema + parameterized
Cypher template. `lib/ontology-gate.ts:dispatch()` is the ONLY write path: validate against the
manifest → refuse unknown labels/patterns (`OffOntologyWrite`) → parameterized MERGE → provenance
props (`_src, _ts, _actor`) on every node and edge. **An off-ontology fact is unrepresentable.**
Plain Cypher only (no GDS): value clouds cluster app-side; causal/shared paths use variable-length
traversal.

### 3 · The agent layer (`lib/traverse.ts` · `lib/passport.ts`)
The agent never freeforms Cypher. It reads through **typed traversal templates** —
`sameWorkPath`, `valuesPath`, `sharedContextPath`, `personNeighborhood`, `standoutFacts` — each
returning candidates WITH their `path_receipt` (`[{from, rel, to}]`, the actual edges walked).
`buildPassport()` assembles: two finds (same-work + values-aligned, deduped), why-lines through a
**deterministic guard** (a why may reference ONLY proper nouns present in its receipt — one retry,
then fail loud), the hidden scavenger prompt (deterministic, from the rarest standout fact), the
**magic inference** (an interpretive read of the person's own words — guarded to never restate
verbatim, never invent facts), and a gradient derived from stable hashes of who they are. Output
validates against `passport/schema.ts` — grounding by construction.

### 4 · The inference pipeline (RocketRide Cloud · `pipeline/party-passport.pipe`)
The `.pipe` (portable JSON DAG) is **deployed and resident** on cloud.rocketride.ai; invocation is
task-token-gated (`pipeline/client.ts`: `runInference()` → pipe first, Butterbase-gateway fallback so
the build never blocks). The `passport_inference` leg (magic inference) routes through it — the app
as thin client over a managed production endpoint.

### 5 · The model plane (Butterbase AI gateway · `lib/gateway.ts`)
Every LLM and embedding call routes through Butterbase's OpenAI-compatible gateway with one key:
`chat(model, messages, zodSchema)` gives schema-validated JSON with one corrective retry then a loud
`GatewaySchemaError`; `embed()` for vectors. Mid-event the gateway's embeddings surface 502'd across
all models — clustering fell back to **chat-surface grouping under a deterministic partition-repair
guard** (code enforces the partition; the model only proposes) — method changed, bar unchanged,
provenance says so.

### 6 · The audit (`scripts/audit-receipts.ts` + the goal gate)
`verify-goal.sh` runs a leg per goal (contract: `gx/goals/usp-v1.md`): ontology conformance (zero
off-manifest labels/rels, zero unprovenanced writes), cluster cardinality, **the receipts audit** —
every `path_receipt` edge and every recommended person on every passport must exist in the live
graph or the gate exits nonzero. Current run: **0 unreceipted claims across 193 passports.**

### 7 · The enrichment layer (provenance-marked, honest)
The real Luma export carries name/school/major/year. `scripts/precache.ts` normalizes the mess (six
spellings of IYA → one node) and enriches deterministically from a **persona-archetype library**
(cheap-model swarm) + a **unique-voice pass** (193 distinct working-on/belief lines, zero repeats) +
an **interest distillation** (what people SAY → 164 canonical tags, 48 shared — the amber bridges).
Every derived field is marked derived in provenance; founder rows carry real data via
`data/real-overrides.json`.

**Bonus integrations (status kept honest):**

- **Cognee** — agent memory (OSS, Neo4j-backed). Planned; wired only after the three mandatories are
  green. *Not yet integrated.*
- **Daytona** — sandbox. No code-run surface on the demo path, so intentionally skipped. *Not integrated.*

## Quickstart

```bash
cp .env.example .env     # fill Neo4j + Butterbase (+ RocketRide) creds; runs DEGRADED without them
npm install              # deps are pinned (next15 / react19 / neo4j-driver6 / openai / zod / tsx …)

npx tsx scripts/precache.ts <luma-export.csv> data/party.csv   # normalize + enrich the real guest list
# (or: npm run gen:csv for the synthetic 40-person test CSV)
npm run ingest           # CSV → ontology-gated graph (through the deployed .pipe / gateway)
npm run passports        # agent traverses the graph → data/passports/<personId>.json
npm run dev              # http://localhost:3000 — the Universe + passport surfaces

npm run verify:goal      # the usp-v1 goal gate (ingest · values · passport · universe · ship)
npx tsx scripts/check-ship.ts   # the ship checklist (submission · README · pipe · passports · live URL)
```

Every credential is read from `process.env` and **never hardcoded**. With a cred missing, the app
boots in **DEGRADED mode** and the first gateway call throws a *named* error telling you which env is
absent — fail loud, no silent fake answers.

## AI disclosure

This project was **built live by an AI lab process** (the gx product-build method), and we treat that
as a **differentiator, not a footnote.**

- **Human-originated.** The vision is **Johnny's**; the design language and tokens are **Teri's**; the
  distribution framing and the DNA-gradient are **Sarah's**. The humans originate and judge; the AI
  captures, organizes, drafts, and executes — it never invents the vision.
- **Invisible to the end user, transparent to you.** On the passport, the AI is deliberately
  unfelt — no chatbot, no "generated by AI" badge, just a gift that happens to know things. In this
  repo it is fully disclosed: how it's wired, where the model is load-bearing, and what it can and
  can't do.
- **Grounded, not vibes.** Every claim on a passport carries a `path_receipt` that must resolve to real
  graph edges, or it's a bug. The AI cannot write an off-ontology fact — the gate makes it
  *unrepresentable*. Deterministic guards wrap every model call (validate → retry once → fail loud).

The honest version of "we used AI to build this" is: *humans decided what's true and beautiful; the
machine made it concrete, under receipts.*

---

Contract: `gx/goals/usp-v1.md`. Project brain + laws + window-ownership map: `CLAUDE.md`.
Demo: `docs/DEMO-SCRIPT.md`. Submission: `docs/SUBMISSION.md`. Positioning: `docs/POSITIONING.md`.

**Team:** JOHNNY SHENG — PART-TIME WARRIOR · TERI SHIM — FOUNDING DESIGNER.
Built live by an AI lab · human-originated · fully disclosed.
