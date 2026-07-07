# Ultra Super Party Passport — HackwithBay 3.0 submission

> Draft of the event's project-description fields. Kept honest: anything not yet live is marked
> `STATUS:` inline rather than claimed. Story anchors trace to `docs/STORY-AMMO.md`.

**One line.** Every event you've ever been to was curated — you just never got to see it. Sign up
to this party and you do: the room wires itself toward you, and a passport writes itself — the two
people to find tonight and one thing it somehow knew about you — because underneath is a
*relational* graph of the room, not a knowledge graph of you.

---

## Problem

People go to events **for the people** — that is what an event *is*: a host curating humans into a
room. But events only ever show you the lineup, the venue, the call-to-actions. Never the people.
You can't see what kind of person you'd end up meeting or what environment to expect; the one thing
the event was actually curated around is the one thing it hides (raw/0016). So you walk into a room
somebody designed *for you* — blind — and all the who-should-I-talk-to math happens in your head,
alone. The information to fix this already exists — everyone filled out a sign-up form — but it
sits in a spreadsheet, not in your hand.

**The product answer, in the team's own words:** it's only when you see your social graph that you
see how the event is curated toward you — and the passport is how you carry that curation into the
room, before the event and live during it (as people check in, the room re-curates).

The deeper problem is the one our team has been circling for a year: among people who are materially
fine, the ache isn't competency, it's *existential* — **who am I, and how do I relate to the people
around me** (`claim:existential-not-competency`). The fix we believe in is **AI as an honest
mirror**: reflect a true perspective back so you can make better choices
(`claim:solution-ai-honest-mirror`). A party passport is the smallest, most fun version of that
mirror — and it lets us prove the mechanism live.

And it must stay **invisible**. The moment you say "AI," people flinch and stop handing over
information (`claim:the-moment-you-say-ai`, `claim:trust-is-the-gate`). So there is no chatbot and no
"generate report" button. You fill a Luma-style form; what comes back is a beautiful passport. The
model is load-bearing and completely unfelt (`concept:invisible-ai`).

## The graph model

This is the core of the submission. It is **relational, not a knowledge graph** — a knowledge graph
catalogs one person's tags; this connects *people* to *people* through a typed ontology
(`claim:relational-not-knowledge-graph`).

**One source of truth.** `ontology/manifest.ts` (zod) declares every legal object type, link type,
and action. Nothing else defines the schema.

- **Objects:** `Person`, `School`, `Major`, `Company`, `Activity` (normalized what-you-do),
  `Belief`, `ValueCluster`, `Party`.
- **Links (allowlist):** `STUDIES_AT`, `MAJORS_IN`, `WORKS_AT`, `DOES` / `WORKING_ON`, `BELIEVES`,
  `Belief -[:IN_CLUSTER]-> ValueCluster`, `Person -[:SHARES_VALUE {cluster,basis}]-> Person`,
  `Person -[:SIGNED_UP {checked_in, checked_in_at}]-> Party`.
- **The gate is the only pen.** Every write goes through `lib/ontology-gate.ts`: validate against the
  manifest → parameterized Cypher → stamp provenance. Off-ontology labels/rels are *unrepresentable*
  — the pipeline literally cannot invent a node type (grounding-by-construction). No raw driver
  writes exist anywhere else.
- **Kinetic layer (typed actions).** Writes are declared actions, not ad-hoc queries:
  `ingest_person`, `write_value_cluster`, `check_in` — each with a zod parameter schema, a Cypher
  template, and provenance. Reads are traversal templates: `same_work_path`, `values_path`,
  `person_neighborhood`.
- **Provenance on everything.** Every node and rel carries `{_src, _ts, _actor}` — "why is this here"
  is always answerable.
- **Values are computed, not typed by hand.** The belief answer ("what does it mean to be creative?")
  is embedded through the gateway, clustered app-side (no GDS on Aura Free), and the clusters are
  written back as `ValueCluster` nodes with `SHARES_VALUE` edges — through the same gate.

**Why this wins the graph track.** The passport can *only* be written because the edges are real: the
two-people-to-find and every "why" are extracted from actual graph paths, with a `path_receipt` that
must resolve or the claim is a bug (`dot` grounded-counts). A typed ontology of Person→Person edges is
the semantic-layer story, not a bag of tags.

## How Butterbase is integrated

Butterbase is the backbone, integrated four ways:

1. **Backend + auth** — app data and sign-in run on Butterbase. `STATUS: wiring in progress.`
2. **AI gateway (deep integration).** *Every* LLM and embedding call routes through the
   OpenAI-compatible Butterbase gateway (`lib/gateway.ts`): one `bb_sk_` key, `baseURL` override, the
   stock `openai` client. Belief embeddings (G3), passport-copy generation (G1), and any extraction
   all go through it — never a direct provider SDK. Deterministic guards wrap every call (schema
   validate → one retry → fail loud). `STATUS: gateway client built + wired.`
3. **Deploy target.** The app deploys to Butterbase; the deployed URL is the demo URL.
   `STATUS: pre-deploy.`
4. **Submission venue.** Final submission is made via the **Butterbase MCP**.

## How RocketRide is integrated

RocketRide is the **inference path**. The ingest/inference `.pipe` (`pipeline/*.pipe`) is **deployed to
cloud.rocketride.ai** and called by the app over HTTP (`POST /task/data`, `Authorization: Bearer`) —
a deployed pipeline, not a local script. Local/Docker execution does not count; the deployed endpoint
is what the app hits. `STATUS: pipe authored; deploy pending — check-ship gate stays red until the
.pipe exists and the live URL 200s.`

## Bonus integrations

- **Cognee** (agent memory, OSS + Neo4j backend) — a natural fit for persisting what the passport
  agent learns across parties. `STATUS: placeholder — wire only after the three mandatories are green.`
- **Daytona** (sandbox) — no code-run surface is on the demo path, so intentionally skipped unless one
  appears.

## Team

- **Johnny Sheng** — technical founder; originated the vision and built the system live with the gx AI
  lab process.
- **Teri** — cofounder, product + design; owns the Universe/passport visual language and the design
  tokens (deliberately **not** space-themed — clean glass-orb / spectrum).
- **Sarah** — cofounder; distribution, the viral-ticket framing, and the DNA-gradient idea
  (the passport back).
- Built live by the **gx AI lab** — human-originated (Johnny's vision, Teri's design), AI-executed. See
  the AI-disclosure section of the README; we treat the disclosure as a differentiator, not fine print.

## Repository

- Code: `https://github.com/Jshengdev/ultra-super-party-passport` &nbsp;`STATUS: placeholder — fill with the public GitHub URL before submit.`
- Live demo: `https://ultra-super-party-passport.butterbase.dev` &nbsp;`STATUS: placeholder — the deployed Butterbase URL.`
- Demo video / script: `docs/DEMO-SCRIPT.md`
