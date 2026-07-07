# THE ULTRA SUPER SOCIAL PASSPORT™ — positioning & clarity

> The shareable source of truth for what this project is, why it exists, and how the stack makes
> it possible. Every claim here is honest to what is built and live at
> **https://ultra-super-party-passport.butterbase.dev**. Hand-off copy for design, pitch, and
> submission — HackwithBay 3.0, built 2026-07-07.

---

## The one-breath

**The Ultra Super Social Passport™ turns any event's guest list into a living relational map of
the room — and hands every guest a passport: the two people they should find tonight, why, and
one line about them it was never told.** Drop a CSV; a passport writes itself.

---

## The problem

**Every event you've ever been to was curated — you just never got to see it.**

Events sell the lineup, the venue, the ticket — never the people. A guest list of 200 says
"software engineer" two hundred times and tells you nothing about which one you'd talk to for
three hours. All the *should-I-go-talk-to-them* math happens alone, in your head — which is why
big rooms are exhausting.

The review that sells it (sales-101, regret-inversion):

> *"I regret getting a passport for this party."*
> Not because it knew my people.
> Not because it's cute as f•.
> **Because I didn't have it for the last five parties.**

You don't *need* a social passport. You just never go back to a stat-listed room after you've
been handed a curated one.

---

## The wave

**Curated everything is eating the calendar.** Supper clubs. Run clubs. Listening bars.
Invite-only everything. The events got curated — **the guests didn't.** The guest experience is
still a name-tag and a hope.

We're the guest side of the wave: the room, curated toward each person standing in it. That's
the new market — every Luma export, every Partiful list, every conference badge-file is an
un-mapped room waiting to be turned into one.

**This is relational, not a knowledge graph.** A knowledge graph catalogs one person's
taglines; this connects *people*. That distinction is the product.

---

## The product

**The flow:** drop the guest list (any CSV — a Luma export, a spreadsheet) → the analysis plays,
every number on screen parsed live from the actual file → **the Room** opens: 193 people as one
organic mesh, connected by school, craft, belief, and interest → type your name → the matched
name waves in gradient on the map → *"I'm going"* → **Generate my passport** → the cover flips
open into your document.

**Two surfaces, one graph:**
- **The Universe (the wow):** a paper-white relational map. People are quiet ink dots; the six
  value clouds tint the room; shared interests — distilled from what each guest *says* — are the
  visible touchpoints that bridge strangers. Nothing glows until you touch it: select anyone and
  their whole web ignites while the room falls back to paper.
- **The Passport (the artifact):** Teri's document — name-tag stamp for your same-type-of-work
  find, the *you-both-believe* stamp quoting your values-match's actual line, the round party
  stamp, a full data page (school · major · grad year · position · "What is a creative?"), the
  machine-readable zone, foil that tilts and shimmers under your cursor, a gradient flute
  generated from who you are — and a headshot frame you can **sketch yourself into** with a
  gradient brush. Download it, share it, scan the QR to carry it on your phone.

**The design language:** pepl cloud-white, mono small-caps, the soft-premium gradient (pale
pink → peach → gold → sage → dusty blue) as the brand's voice, passport ornaments (stamps,
guilloche, MRZ) as the interface grammar.

**The stance — invisible AI:** it never says AI and never feels like AI. The room just knows
you. One magical line on every passport — inferred only from what you gave, never scraped —
lands the moment: *"I didn't give this to it. How does it know?"*

---

## The techstack — why each piece, and what it makes possible

### Butterbase — the backend of record & the agent-native control plane
Everything administrative lives on Butterbase: the `signups` and `passports` tables (all 193
real rows seeded), the **OpenAI-compatible AI gateway** every single model call routes through
(one key, provider-agnostic — why-lines, magic inferences, interest distillation, cluster
naming), and the **live deploy** — the entire app ships as a static bundle to
ultra-super-party-passport.butterbase.dev with one tool call. The deeper point: the app was
provisioned, schema'd, seeded, deployed, and will be **submitted** through Butterbase's MCP —
the backend is operated agent-natively end to end, which is exactly the workflow the platform
was built for.

### Neo4j Aura — the ontology (the product's soul)
The guest list becomes a **typed property graph**: `Person`, `School`, `Major`, `Activity`,
`Belief`, `ValueCluster`, `Interest` nodes; `STUDIES_AT`, `MAJORS_IN`, `WORKS_AT`, `DOES`,
`WORKING_ON`, `BELIEVES`, `IN_CLUSTER`, `SHARES_VALUE`, `INTERESTED_IN`, `SIGNED_UP` links.
Two design decisions make it Palantir-grade rather than a bag of nodes:

1. **The ontology gate.** There is exactly one write path: typed actions (`ingest_person`,
   `write_value_cluster`, `write_interests`, `check_in`) validated against a single zod
   manifest — labels, link types, and (subject, REL, object) patterns are allowlisted, and
   every write carries provenance (`_src`, `_ts`, `_actor`). An off-ontology write is
   *unrepresentable*, not just discouraged.
2. **Typed traversal.** The agent never free-runs Cypher. It walks declared read templates —
   same-work paths, shared-value paths, neighborhoods, standout facts — each returning the
   path itself as a receipt. Plain Cypher only (relationship retrieval, variable-length
   paths); no GDS required, so it runs on Aura Free.

### RocketRide Cloud — the deployed inference pipeline
The `party-passport.pipe` — a portable JSON pipeline — is **deployed and resident on
cloud.rocketride.ai** as a managed endpoint (task-token invocation contract). The
passport-inference leg (the magic line) routes through it, with the Butterbase gateway as the
verified fallback path, so inference is a *deployed production surface*, not a laptop process.

### The audit — receipts, or it doesn't ship
Every claim on every passport carries a `path_receipt`: the actual `{from, rel, to}` edges the
agent walked. An audit script verifies **every receipt edge and every recommended person exists
in the live graph** — the shipped set audits at **zero unreceipted claims**. Guards wrap every
model call: a why-line may not contain a proper noun absent from its receipt (rejected and
retried, then failed loud); a magic inference must be an interpretive read, never a restatement,
and never a fact the guest didn't give. Failures are loud and visible — there is no silent
fallback anywhere in the pipeline.

### The invisible precache — why it feels instant
Building the room for real — normalization, enrichment, clustering, 4,000+ edge writes — takes
minutes. So it's pre-run, and the first page *replays* it as the analysis: every number shown
(193 guests, 41 pending, six spellings of IYA folding into one node) is parsed live from the
actual file you drop, and the static build **bakes the live Neo4j graph** into the bundle at
export time. Real work, presented at the speed of theater.

### The enrichment layer — reflection, honestly marked
A Luma export is thin (name, school, major, year). The enrichment pass gives the room its
texture: persona archetypes simulated by a swarm of small models, **193 fully unique voices**
(zero repeated phrasings), role lines (`Position` is a derived role, never an invented
employer), and **interests distilled from what each person says** — 164 canonical one-liner
tags, 48 of them shared by two or more people, forming the touchpoints that bridge the clouds.
Every derived field is provenance-marked as derived. When this runs on a real signup form (one
extra question: *"what do you think it means to be creative?"*), the same pipeline runs on
fully real answers.

---

## The numbers

**193** guests, one CSV · **6** value clouds · **3,133** shared-value ties · **164** interests
(48 shared) · **4,102** links in the room · **193** passports pre-generated ·
**0** unreceipted claims.

---

## What's next

Live at the **LA intern party 7/18** — the room re-curates as guests check in (the two-state
design: signed-up vs. actually-here) · **wallet passes** (scan-to-phone QR ships today; signed
.pkpass next) · the platform: **create your event** Luma-style, and every guest list becomes a
room.

---

## Team

**JOHNNY SHENG — PART-TIME WARRIOR · TERI SHIM — FOUNDING DESIGNER**

Built live by an AI lab. Human-originated. Fully disclosed.
*The Ultra Super Social Passport™*
