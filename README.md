# The Ultra Super Social Passport™

**Live:** [ultra-super-party-passport.butterbase.dev](https://ultra-super-party-passport.butterbase.dev) ·
**Deck:** [/deck](https://ultra-super-party-passport.butterbase.dev/deck) ·
**Positioning:** [/positioning.html](https://ultra-super-party-passport.butterbase.dev/positioning.html) ·
**Demo video:** [Drive](https://drive.google.com/drive/folders/1DDGzIAD0a9tTNt1ZJwswI6IPLzXwfc9H?usp=drive_link)

**312 real guests · 22 value clusters · 2,091 shared-value ties · 962 directed seeking edges ·
312 passports · 6,080 + 1,088 receipts · 0 unreceipted claims**

**Sign up to a party, and a passport writes itself** — the two people you'd click with tonight and one
thing it somehow knew about you. It's **relational, not a knowledge graph of tags** (it connects
people), and the AI is completely **invisible**.

Our HackwithBay 3.0 entry (submitted — entry `d7a73662`, v3), built for a real event: an LA intern
party for creatives (7/18). It now runs on the party's **real 312-person guest list** — the full Luma
export with four free-text answers per guest — after the original 193-person build-week population
was retired to git history in an authorized reset. Every guest gets a passport: the people to find
(each with a receipted reason), a hidden scavenger prompt, a **magic inference** ("how does it
know?"), and a gradient generated from who they are.

**The full experience:** drop the guest CSV onto `/graph` (parsed in your browser, verified against
the baked room, never uploaded) → the pipeline's real numbers play as beats → the room: Teri's
redesigned world over the real party — poppable bubbles, craft subsections inside the clouds, school
crests and company logos, connection threads that carry their receipts — → type your name (it waves
in gradient) → the panel: who's looking for someone like you, warm edges inbound → **Generate my
passport** → the cover flips open: foil tilt + holo sheen, stamps, the MRZ line, the sketch frame,
and a QR that puts it on your phone.

---

## The story in one breath

Underneath the party toy is a thesis we've been building for a year: **AI as an honest mirror** — a
tool that reflects a true perspective back so you can make better choices. The passport is the
smallest, most fun version of that mirror: it tells you who you are by telling you who, in this
room, you'd click with and why. And it stays invisible on purpose — the moment you say "AI," people
flinch and stop sharing. So there's no chatbot. You fill a form; you get a gift.

## Stack

Three integrations are load-bearing (deep-integration or it doesn't count):

```
  The party's REAL Luma export (364 rows → 312 unique approved guests)
          │  name · company · title · school · hometown · instagram
          │  + four answers: what drew you · ultimate goal · who you seek · inspiration
          ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Butterbase  ── backend + OpenAI-compatible AI gateway        │  the BRAIN + BACKBONE
  │  guarded chat for convictions & passport synthesis            │  (one bb_sk_ key)
  │  deploy target · submission via Butterbase MCP                │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼  writes ONLY through lib/ontology-gate.ts (validate → Cypher → provenance)
  ┌──────────────────────────────────────────────────────────────┐
  │  Neo4j Aura  ── the typed ontology property graph            │  the RELATIONAL LAYER
  │  people ↔ schools/companies/places/activities/beliefs/       │  (a graph, not a KV store)
  │  convictions + directed SEEKS edges; traversed, not stored.   │
  │  off-ontology writes are unrepresentable.                     │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼  agent traverses real paths → path_receipts
      ┌───────────────────────┴───────────────────────┐
      ▼                                                ▼
  /graph  (Teri's room over the real party)    data/passports/<personId>.json — 312 of them
  + /universe (the original map)               (people to find + why · magic line · gradient)
```

RocketRide's deployed `.pipe` (cloud.rocketride.ai) remains the inference path for passport
synthesis — see layer 4.

## Architecture, in detail

**The data flow, end to end:**
`Luma CSV → dedupe + canonicalize (312, non-PII ids) → ontology-gated ingest → guarded conviction
extraction → directed seek matching → gated value-clusters → emit (baked artifacts + the managed
sheet) → passports (receipted) → three audits → static build → Butterbase CDN`

### 1 · The frontend (Next.js 15 · React 19 · TypeScript strict · Tailwind 4 · framer-motion)
App Router; the deploy is a **static export**: every page — including all 312 passports via
`generateStaticParams` — pre-renders at build. Surfaces: `/graph` (the drag-the-CSV entry and
Teri's redesigned room over the real data), `/universe` (the original relational map), `/passport/[id]`
(Teri's document: foil tilt, holo sheen, sketch frame, QR), `/deck`. The graph page reads baked
JSON (`public/graph/*`) — no server, no view-time inference, verified in the browser against the
dropped file.

### 2 · The ontology + the gate (Neo4j Aura · `ontology/manifest.ts` · `lib/ontology-gate.ts`)
One zod manifest is the single source of truth: object types (`Person, School, Major, Activity,
Belief, ValueCluster, Interest, Party, Company, Place, Inspiration`), a **patterns allowlist**
(`STUDIES_AT, MAJORS_IN, WORKS_AT, DOES, WORKING_ON, BELIEVES, IN_CLUSTER, SHARES_VALUE,
INTERESTED_IN, SIGNED_UP, FROM, INSPIRED_BY, SEEKS`), and **typed ACTION definitions**
(`ingest_person, ingest_guest_v2, write_value_cluster, write_seek_edge, write_interests, check_in,
reset_graph`) — each a zod schema + parameterized Cypher. `dispatch()` is the ONLY write path:
validate → refuse unknown labels/patterns → parameterized MERGE → provenance (`_src, _ts, _actor`)
on every node and edge. **An off-ontology fact is unrepresentable.** Plain Cypher only (no GDS) —
clustering happens app-side.

### 3 · The agent layer (`lib/traverse.ts` · `lib/passport.ts`)
Typed traversal templates — `sameWorkPath`, `valuesPath`, `sharedContextPath`, `seeksPath`,
`personNeighborhood`, `standoutFacts` — each returning candidates WITH their `path_receipt`.
`buildPassport()` assembles the finds (same-work + values-aligned; a real `SEEKS` edge is the
last-resort anchor — "they told the sheet they're looking for someone like you" — and one true
structural singleton honestly ships a single find rather than a fabricated second), why-lines
through a **deterministic guard**, the scavenger prompt, the magic inference, the gradient. Output
validates against `passport/schema.ts` — grounding by construction.

### 4 · The inference pipeline (RocketRide Cloud · `pipeline/party-passport.pipe`)
The `.pipe` is **deployed and resident** on cloud.rocketride.ai; `runInference()` goes pipe-first
with a Butterbase-gateway fallback so the build never blocks. The `passport_inference` leg routes
through it — the app as thin client over a managed endpoint.

### 5 · The model plane (Butterbase AI gateway · `lib/gateway.ts`) — and the honest fallback ledger
Every LLM call routes through the gateway: `chat(model, messages, zodSchema)` returns
schema-validated JSON with one corrective retry then a loud error. Convictions run on a
golden-calibrated model (`CONVICTION_MODEL`), and every extracted quote is **snapped to the exact
byte span of the guest's own answer** — receipts are literal by construction. The environmental
truth, on the record twice: mid-event the gateway's embeddings 502'd (clustering fell back to
chat-surface grouping under a partition-repair guard); post-event the platform removed embedding
models entirely — so seek/doppelgänger matching runs on a **named lexical TF-IDF fallback**
(`EMBED_PROVIDER`, provenance `match:tfidf-v1` on every edge, the gateway path retained for when
embeddings return). Method changed, bar unchanged, provenance says so.

### 6 · The audits — three of them, all able to FAIL
`scripts/audit-receipts.ts`: every passport `path_receipt` edge and every recommended person must
exist in the live graph — **312 passports · 1,088 receipt edges · all grounded**.
`scripts/audit-graph.ts`: every artifact receipt byte-checked against the sheet, every numeric claim
independently re-counted, seek edges reconciled against Neo4j **both ways** — 6,080 receipts, 0
violations. `scripts/check-graph-e2e.ts`: serves the built site and traces a rendered receipt back
to the CSV cell it came from. Plus conformance (zero off-manifest anything) and the goal gate.

### 7 · The managed dataset (the curation loop — new, and already used in production)
`data/graph-enriched.csv` — one row per guest, every computed field visible (37 columns: identity,
conviction tags with verbatim quotes, groups, top-5 matches, doppelgänger). A sparse
`data/graph-overrides.csv` steers it: retag, hide, pin — off-vocabulary values fail loud, quotes are
untouchable, every override lands in the artifacts with `_overridden` provenance. Teri's redesign
shipped with her own override entries (splitting a generic motive into personality motives), which
is exactly the loop working: **designers curate data through a CSV; the gates prove nothing broke.**

**Bonus integrations (status kept honest):** Cognee — planned, *not yet integrated*. Daytona —
intentionally skipped.

## Quickstart

```bash
cp .env.example .env      # Neo4j + Butterbase (+ RocketRide) creds; DEGRADED without them
npm install

# Visual work needs NO creds — the artifacts are committed:
npm run dev               # /graph (the real party) · /universe · /passport/<id>

# The v2 pipeline (tsx does NOT autoload .env — source it first):
set -a; source .env; set +a
export GUESTS_CSV="<the Luma export>" EMBED_PROVIDER=tfidf CONVICTION_MODEL=anthropic/claude-haiku-4.5
npx tsx scripts/ingest-guests.ts          # gated ingest (312, non-PII ids)
npx tsx scripts/enrich-convictions.ts     # guarded extraction, quote-snapped receipts
npx tsx scripts/enrich-matches.ts         # seek matrix → gated SEEKS edges
npx tsx scripts/write-conviction-values.ts# conviction groups → value clusters
npx tsx scripts/emit-graph.ts             # baked artifacts + the managed sheet
PASSPORT_CONCURRENCY=6 npx tsx scripts/generate-passports.ts

# The gates (each can fail; green means proven):
npx tsx scripts/check-conformance.ts && npx tsx scripts/check-graph-emit.ts \
  && npx tsx scripts/audit-graph.ts && npx tsx scripts/audit-receipts.ts
```

Every credential is read from `process.env` and **never hardcoded**; missing creds → **DEGRADED
mode** with a *named* error. No emitted artifact contains an email, phone number, or wallet address —
the PII tripwire is part of the gates.

**Changing this repo (human or agent): `CLAUDE.md` is the source of truth** — the laws, the code
map, the command chains, and the gates a change must keep green. Everything else is meant to be
learned by reading the code; rationale lives in constraint comments at the source.

## AI disclosure

This project was **built live by an AI lab process** (the gx product-build method), and we treat that
as a **differentiator, not a footnote.**

- **Human-originated.** The vision is **Johnny's**; the design language, tokens, and the redesigned
  room are **Teri's**; the distribution framing and the DNA-gradient are **Sarah's**. The humans
  originate and judge; the AI captures, organizes, drafts, and executes — it never invents the vision.
- **Invisible to the end user, transparent to you.** On the passport, the AI is deliberately
  unfelt — no chatbot, no badge, just a gift that happens to know things. In this repo it is fully
  disclosed: how it's wired, where the model is load-bearing, and what it can and can't do.
- **Grounded, not vibes.** Every claim carries a receipt that must resolve — to a real graph edge, a
  byte-literal quote from the guest's own answer, or an independently re-derived count — or a gate
  fails. The AI cannot write an off-ontology fact; deterministic guards wrap every model call
  (validate → retry once → fail loud).

The honest version of "we used AI to build this" is: *humans decided what's true and beautiful; the
machine made it concrete, under receipts.*

---

Contract: `gx/goals/usp-v1.md` (+ the as-built departure report in
`docs/superpowers/specs/2026-07-25-party-graph-design.md`). Project brain + laws + code map: `CLAUDE.md`.
Demo: `docs/DEMO-SCRIPT.md`. Submission: `docs/SUBMISSION.md`. Positioning: `docs/POSITIONING.md`.

**Team:** JOHNNY SHENG — PART-TIME WARRIOR · TERI SHIM — FOUNDING DESIGNER.
Built live by an AI lab · human-originated · fully disclosed.
