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
