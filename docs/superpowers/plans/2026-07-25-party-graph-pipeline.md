# Party Graph v2 — Full Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The real 312-guest CSV flows through the ontology gate into Neo4j, gets gateway-enriched (convictions, seek matches, doppelgängers), emits audited `public/graph/` artifacts, and renders as the 3-lens `/graph` route.

**Architecture:** Spec at `docs/superpowers/specs/2026-07-25-party-graph-design.md`. Four stages behind `npx tsx` scripts (normalize → gate-ingest → enrich → emit) plus an audit that can FAIL, then a static-exportable canvas route that reads the baked JSON. All writes via `dispatch()`; all LLM calls via `lib/gateway.ts` with zod guards; DEGRADED (exit 2, named error) without creds.

**Tech Stack:** TypeScript strict, zod, papaparse, neo4j-driver via `lib/neo4j.ts`, OpenAI-compatible gateway via `lib/gateway.ts`, Next 15 App Router, canvas 2D. No new dependencies.

## Global Constraints

- Do NOT touch `package.json`, `.env*`, or `.git` config. All commands run as `npx tsx scripts/<name>.ts`.
- Every graph write goes through `dispatch()` from `lib/ontology-gate.ts` — no raw Cypher anywhere else.
- Every LLM/embedding call goes through `lib/gateway.ts` (`chat<T>` with zod schema / `embed`) — validate, retry once, fail loud. No creds → print named error, `process.exit(2)`.
- Provenance on every write: gate injects `{_src, _ts, _actor}`; pass `{src: "csv:la-intern-party", actor: "pipeline"}`.
- **PII rule:** raw CSV path comes from `GUESTS_CSV` env (never committed). No emitted file under `public/graph/` may contain an email, phone, `.edu` address, wallet address, or QR URL. `personId` = `slug(name)` + `-` + 4-char hash of `guest_id` — never the email localpart.
- Dedup FIRST: 325 approved rows → 312 unique by `guest_id` (first occurrence wins).
- The `/graph` route must build under `STATIC_EXPORT=1` (no dynamic APIs, no query params; hash fragments OK). `/universe`, `/passport/*`, check-in flow untouched.
- Design: import `@/passport/tokens.css` per-route like `app/universe/page.tsx` does; canvas colors read via `getComputedStyle`, never invented hexes. Light-only.
- Copy law: person-anchored facts are positive-or-neutral; zero-counts never render; `flags` never render.
- `npx tsc --noEmit` must be clean at every commit.

## Reference material (read before starting any task)

- `ontology/manifest.ts` — OBJECT_SCHEMAS, LINKS allowlist, ACTIONS registry (mirror `ingest_person` exactly for shape).
- `lib/ingest.ts` — existing CSV→params pattern; `lib/gateway.ts` — `chat`, `embed`, `isGatewayConfigured`, `GatewayNotConfigured`; `lib/neo4j.ts` — `run`, `isConfigured`, `toNum`.
- `scripts/extract-interests.ts` — the batched guarded-chat pattern (BATCH=20) to copy.
- Prototype to port for the route: `/private/tmp/claude-501/-Users-johnnysheng-code-ultra-super-party-passport/b1a576dd-fe4f-49d2-bb37-90dbd81138a5/scratchpad/graph-lab.html` (working canvas code: `simTick`, `ringLayout`, `draw`, `pick`, `select`, `openReceipt`, camera/pointer handlers).
- The CSV column headers (exact, note the curly quotes):
  `guest_id`, `name`, `email`, `created_at`, `approval_status`, `checked_in_at`,
  `Company? (if you are freelance, just say "creative")`,
  `Job title? (if you are freelance, just state your typical role e.g. "Director")`,
  `Hometown?`, `Instagram handle?`, `School? (e.g. USC '27)`,
  `Favorite movie/show?`, `What drew you to the entertainment industry?`,
  `Whats your ultimate goal in pursuing entertainment? (e.g. being a director, representation, etc.)`,
  `What kind of people are you looking to connect with?`, `Who is your biggest inspiration?`

---

### Task 1: Ontology extension — Place, Inspiration, SEEKS, and `ingest_guest_v2`

**Files:**
- Modify: `ontology/manifest.ts` (OBJECT_SCHEMAS, LINKS, ACTIONS)
- Test: `scripts/check-graph-ontology.ts` (new)

**Interfaces:**
- Produces: gate actions `ingest_guest_v2` (params below) and `write_seek_edge`; labels `Place {name, lat, lng}`, `Inspiration {name}`; links `Person-FROM->Place`, `Person-INSPIRED_BY->Inspiration`, `Person-SEEKS->Person {score, mutual, via}`.
- `IngestGuestV2Params = { person: {id, name, position}, school: string|null, company: string|null, place: {name, lat, lng}|null, inspiration: string|null, party: {id, name, date} }`

- [ ] **Step 1: Write the failing check**

```ts
// scripts/check-graph-ontology.ts
import { ACTIONS, LINKS, OBJECT_SCHEMAS } from "../ontology/manifest";
const fail = (m: string) => { console.error("FAIL:", m); process.exit(1); };
if (!(OBJECT_SCHEMAS as Record<string, unknown>)["Place"]) fail("Place label missing");
if (!(OBJECT_SCHEMAS as Record<string, unknown>)["Inspiration"]) fail("Inspiration label missing");
const rel = (r: string) => (LINKS as Array<{ rel: string }>).some(l => l.rel === r);
if (!rel("FROM") || !rel("INSPIRED_BY") || !rel("SEEKS")) fail("link missing (FROM/INSPIRED_BY/SEEKS)");
const act = (a: string) => (ACTIONS as Record<string, unknown>)[a] !== undefined;
if (!act("ingest_guest_v2") || !act("write_seek_edge")) fail("action missing");
console.log("graph ontology OK");
```

- [ ] **Step 2: Run it — expect FAIL** — `npx tsx scripts/check-graph-ontology.ts` → `FAIL: Place label missing`, exit 1. (If ACTIONS/LINKS/OBJECT_SCHEMAS aren't exported, first add `export` to those consts — they are the manifest's own tables.)

- [ ] **Step 3: Extend the manifest.** Mirror the existing entries' exact structure. Add to OBJECT_SCHEMAS:

```ts
Place: z.object({ name: z.string().min(1), lat: z.number(), lng: z.number() }),
Inspiration: z.object({ name: z.string().min(1) }),
```

Add to LINKS (same shape as existing rows, with props where the existing `SHARES_VALUE` row shows how):

```ts
{ from: "Person", rel: "FROM", to: "Place" },
{ from: "Person", rel: "INSPIRED_BY", to: "Inspiration" },
{ from: "Person", rel: "SEEKS", to: "Person", props: ["score", "mutual", "via"] },
```

Add two ACTIONS, copying `ingest_person`'s structure (zod params + `writesLabels` + `writesPatterns` + parameterized Cypher; the gate injects provenance):

```ts
ingest_guest_v2: {
  params: z.object({
    person: z.object({ id: z.string().min(1), name: z.string().min(1), position: z.string().default("") }),
    school: z.string().nullable(), company: z.string().nullable(),
    place: z.object({ name: z.string().min(1), lat: z.number(), lng: z.number() }).nullable(),
    inspiration: z.string().nullable(),
    party: z.object({ id: z.string(), name: z.string(), date: z.string() }),
  }),
  writesLabels: ["Person", "School", "Company", "Place", "Inspiration", "Party"],
  writesPatterns: ["Person-STUDIES_AT->School", "Person-WORKS_AT->Company", "Person-FROM->Place", "Person-INSPIRED_BY->Inspiration", "Person-SIGNED_UP->Party"],
  cypher: `
    MERGE (p:Person {id: $person.id})
      SET p.name = $person.name, p.position = $person.position, p._src = $_src, p._ts = $_ts, p._actor = $_actor
    MERGE (party:Party {id: $party.id}) ON CREATE SET party.name = $party.name, party.date = $party.date, party._src = $_src, party._ts = $_ts, party._actor = $_actor
    MERGE (p)-[su:SIGNED_UP]->(party) ON CREATE SET su.checked_in = false, su._src = $_src, su._ts = $_ts, su._actor = $_actor
    FOREACH (_ IN CASE WHEN $school IS NULL THEN [] ELSE [1] END |
      MERGE (s:School {name: $school}) SET s._src = $_src, s._ts = $_ts, s._actor = $_actor
      MERGE (p)-[r1:STUDIES_AT]->(s) SET r1._src = $_src, r1._ts = $_ts, r1._actor = $_actor)
    FOREACH (_ IN CASE WHEN $company IS NULL THEN [] ELSE [1] END |
      MERGE (c:Company {name: $company}) SET c._src = $_src, c._ts = $_ts, c._actor = $_actor
      MERGE (p)-[r2:WORKS_AT]->(c) SET r2._src = $_src, r2._ts = $_ts, r2._actor = $_actor)
    FOREACH (_ IN CASE WHEN $place IS NULL THEN [] ELSE [1] END |
      MERGE (pl:Place {name: $place.name}) SET pl.lat = $place.lat, pl.lng = $place.lng, pl._src = $_src, pl._ts = $_ts, pl._actor = $_actor
      MERGE (p)-[r3:FROM]->(pl) SET r3._src = $_src, r3._ts = $_ts, r3._actor = $_actor)
    FOREACH (_ IN CASE WHEN $inspiration IS NULL THEN [] ELSE [1] END |
      MERGE (i:Inspiration {name: $inspiration}) SET i._src = $_src, i._ts = $_ts, i._actor = $_actor
      MERGE (p)-[r4:INSPIRED_BY]->(i) SET r4._src = $_src, r4._ts = $_ts, r4._actor = $_actor)
    RETURN p.id AS id`,
},
write_seek_edge: {
  params: z.object({ from: z.string().min(1), to: z.string().min(1), score: z.number().min(0).max(1), mutual: z.boolean(), via: z.string().min(1) }),
  writesLabels: ["Person"],
  writesPatterns: ["Person-SEEKS->Person"],
  cypher: `
    MATCH (a:Person {id: $from}), (b:Person {id: $to})
    MERGE (a)-[s:SEEKS]->(b)
    SET s.score = $score, s.mutual = $mutual, s.via = $via, s._src = $_src, s._ts = $_ts, s._actor = $_actor
    RETURN a.id AS id`,
},
```

Adapt property-access syntax (`$person.id` vs a flattened param) to match how `ingest_person`'s cypher accesses nested params — copy its convention exactly. If the gate's pattern-checker derives patterns from the Cypher, make sure the FOREACH-MERGE forms are representable the same way `ingest_person` writes its optional links; if `ingest_person` handles optionals differently (e.g., separate statements), copy that approach instead of FOREACH.

- [ ] **Step 4: Run checks — expect PASS** — `npx tsx scripts/check-graph-ontology.ts` → `graph ontology OK`; `npx tsc --noEmit` clean; if Neo4j creds present, `npx tsx scripts/check-conformance.ts` still exits 0.

- [ ] **Step 5: Commit** — `git add ontology/manifest.ts scripts/check-graph-ontology.ts && git commit -m "feat(graph): ontology v2 — Place/Inspiration/SEEKS + ingest_guest_v2 through the gate"`

---

### Task 2: `lib/guests.ts` — parse, dedupe, normalize, non-PII personIds

**Files:**
- Create: `lib/guests.ts`
- Test: `scripts/check-guests.ts` (new)

**Interfaces:**
- Produces:
```ts
export interface Guest {
  personId: string; guestId: string; name: string; title: string;
  school: string | null; company: string | null; isFreelance: boolean;
  hometown: string | null; instagram: string | null; createdAt: string;
  answers: { goal: string; drew: string; seeking: string; inspiration: string; favorite: string };
  flags: string[];
}
export function loadGuests(csvPath: string): Guest[];          // approved-only, deduped, normalized
export function personIdOf(name: string, guestId: string): string;
export const GOLDEN_NAMES: string[];                            // adversarial golden sample
```

- [ ] **Step 1: Write the failing check** (runs against the real CSV via `GUESTS_CSV`):

```ts
// scripts/check-guests.ts
import { loadGuests, GOLDEN_NAMES } from "../lib/guests";
const csv = process.env.GUESTS_CSV;
if (!csv) { console.error("GuestsCsvMissing: set GUESTS_CSV"); process.exit(2); }
const fail = (m: string) => { console.error("FAIL:", m); process.exit(1); };
const g = loadGuests(csv);
if (g.length !== 312) fail(`expected 312 unique approved, got ${g.length}`);
if (new Set(g.map(x => x.personId)).size !== 312) fail("personId collision");
if (g.some(x => x.personId.includes("@") || /gmail|\.edu/.test(x.personId))) fail("personId leaks email");
const vianne = g.find(x => x.name === "Vianne Nguyen");
if (!vianne) fail("doubled-name repair missing (Vianne Nguyen)");
const usc = g.filter(x => x.school === "USC").length;
if (usc < 60) fail(`USC canonicalization weak: ${usc}`);
const free = g.filter(x => x.isFreelance).length;
if (free < 60 || g.some(x => x.company === "Creative")) fail("freelance flag broken");
if (g.some(x => x.company && /^nbcu/i.test(x.company) && x.company !== "NBCUniversal")) fail("NBCU alias not merged");
for (const n of GOLDEN_NAMES) if (!g.some(x => x.name === n)) fail(`golden name missing: ${n}`);
console.log(`guests OK: ${g.length} unique, USC=${usc}, freelance=${free}`);
```

- [ ] **Step 2: Run — expect FAIL** — `GUESTS_CSV="/Users/johnnysheng/Downloads/LA INTERN PARTY - Guests - 2026-07-23-06-16-26.csv" npx tsx scripts/check-guests.ts` → module not found / FAIL.

- [ ] **Step 3: Implement `lib/guests.ts`.** Papa parse with `header: true`; filter `approval_status === "approved"` (trim/lower); dedupe by `guest_id` keeping first. Normalizers:

```ts
import Papa from "papaparse";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const COL = {
  company: 'Company? (if you are freelance, just say "creative")',
  title: 'Job title? (if you are freelance, just state your typical role e.g. "Director")',
  hometown: "Hometown?", instagram: "Instagram handle?", school: "School? (e.g. USC '27)",
  favorite: "Favorite movie/show?", drew: "What drew you to the entertainment industry?",
  goal: "Whats your ultimate goal in pursuing entertainment? (e.g. being a director, representation, etc.)",
  seeking: "What kind of people are you looking to connect with?", inspiration: "Who is your biggest inspiration?",
} as const;

const SCHOOL_ALIAS: Record<string, string> = { usc: "USC", "university of southern california": "USC", ucla: "UCLA", "uc berkeley": "UC Berkeley", berkeley: "UC Berkeley", ucsd: "UCSD", uci: "UC Irvine", chapman: "Chapman", "chapman university": "Chapman", emerson: "Emerson", "emerson college": "Emerson", "ut austin": "UT Austin", artcenter: "ArtCenter", "art center": "ArtCenter", "artcenter college of design": "ArtCenter", calarts: "CalArts", gt: "Georgia Tech", "georgia tech": "Georgia Tech", lmu: "LMU", csun: "CSUN", csulb: "CSULB", nyu: "NYU", vanderbilt: "Vanderbilt", "vanderbilt university": "Vanderbilt", "smith college": "Smith", pitt: "Pitt", northwestern: "Northwestern", emory: "Emory", "cal poly pomona": "Cal Poly Pomona", lcad: "LCAD" };
const CO_ALIAS: Record<string, string> = { nbcu: "NBCUniversal", nbcuniversal: "NBCUniversal", "nbcuniversal (universal studios hollywood)": "NBCUniversal", disney: "Disney", "the walt disney company": "Disney", "warner brothers discovery": "Warner Bros Discovery", "warner bros discovery": "Warner Bros Discovery", dreamworks: "DreamWorks", "dreamworks animation": "DreamWorks", "live nation": "Live Nation", "sony music entertainment": "Sony Music", "amc networks": "AMC Networks" };
const FREELANCE = new Set(["creative", "freelance", "freelancer", "independent", "self", "myself", "n/a", "na", "none", "student", ""]);

export function fixDoubledName(n: string): string {
  const t = n.replace(/\s+/g, " ").trim();
  const h = Math.floor(t.length / 2);
  return t.length > 8 && t.length % 2 === 0 && t.slice(0, h).trim() === t.slice(h).trim() ? t.slice(0, h).trim() : t;
}
export function canonSchool(raw: string): string | null {
  let s = raw.trim().replace(/[’'`‘]?\s*\d{2,4}\s*[’'‘]?\s*$/u, "").replace(/\s+/g, " ").replace(/[,.’'‘]+$/u, "").trim();
  if (s.includes("/")) s = s.split("/")[0].trim();
  if (!s) return null;
  return SCHOOL_ALIAS[s.toLowerCase()] ?? s;
}
export function canonCompany(raw: string): { company: string | null; isFreelance: boolean } {
  const k = raw.trim().replace(/\s+/g, " ").toLowerCase().replace(/[,.]+$/, "");
  if (FREELANCE.has(k)) return { company: null, isFreelance: raw.trim() !== "" };
  return { company: CO_ALIAS[k] ?? raw.trim(), isFreelance: false };
}
export function personIdOf(name: string, guestId: string): string {
  const slug = fixDoubledName(name).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
  return `${slug}-${createHash("sha256").update(guestId).digest("hex").slice(0, 4)}`;
}
export const GOLDEN_NAMES = ["Jazmin Paige Lopez", "Vianne Nguyen", "George", "TJ Jalloh", "Michael Vainshtein", "Kayla McIntyre", "Tyler Bumgarner", "Crystal Qianhui Xu", "Keona Edwards", "Maggie Lee"];
```

`loadGuests` assembles `Guest` rows from these helpers, trims all answer fields, and sets `flags` (`missing-school`, `missing-answers` when every free-text field is empty). It must strip the BOM (`utf-8` CSV starts with `﻿` — Papa handles it when parsing the string read with `readFileSync(path, "utf8")`, but verify the first header key doesn't start with `﻿`; strip if present).

- [ ] **Step 4: Run — expect PASS** — same command → `guests OK: 312 unique, ...`; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git add lib/guests.ts scripts/check-guests.ts && git commit -m "feat(graph): guest loader — dedupe 325→312, canonicalize, non-PII personIds, golden sample"`

---

### Task 3: `scripts/ingest-guests.ts` — gate writes into Neo4j

**Files:**
- Create: `scripts/ingest-guests.ts`
- Test: verification queries inside the script + `scripts/check-conformance.ts`

**Interfaces:**
- Consumes: `loadGuests`, `personIdOf` (Task 2); `dispatch(action, params, prov)` from `lib/ontology-gate.ts`; `DEFAULT_PARTY` from `ontology/manifest.ts`.
- Produces: 312 `Person` nodes (id = personId) with `STUDIES_AT/WORKS_AT/FROM/INSPIRED_BY/SIGNED_UP` in Neo4j. Supports `GUESTS_FILTER` (comma-separated guest_ids) for the golden run.

- [ ] **Step 1: Write the script**

```ts
// scripts/ingest-guests.ts
import { loadGuests } from "../lib/guests";
import { dispatch } from "../lib/ontology-gate";
import { isConfigured, run, toNum, close } from "../lib/neo4j";
import { DEFAULT_PARTY } from "../ontology/manifest";

const CITY: Record<string, { lat: number; lng: number }> = { "los angeles": { lat: 34.05, lng: -118.24 }, la: { lat: 34.05, lng: -118.24 }, atlanta: { lat: 33.75, lng: -84.39 }, "new york": { lat: 40.71, lng: -74.01 }, "san francisco": { lat: 37.77, lng: -122.42 }, "san diego": { lat: 32.72, lng: -117.16 }, houston: { lat: 29.76, lng: -95.37 }, philadelphia: { lat: 39.95, lng: -75.17 }, irvine: { lat: 33.68, lng: -117.83 }, "long beach": { lat: 33.77, lng: -118.19 }, "orange county": { lat: 33.72, lng: -117.83 }, denver: { lat: 39.74, lng: -104.99 }, miami: { lat: 25.76, lng: -80.19 }, seattle: { lat: 47.61, lng: -122.33 }, chicago: { lat: 41.88, lng: -87.63 } };
function place(hometown: string | null) {
  if (!hometown) return null;
  const key = hometown.toLowerCase().split(/[\/,]/)[0].trim();
  const c = CITY[key];
  return c ? { name: hometown.split(/[\/,]/)[0].trim(), lat: c.lat, lng: c.lng } : { name: hometown.slice(0, 40), lat: 0, lng: 0 };
}
async function main() {
  if (!isConfigured()) { console.error("Neo4jNotConfigured: NEO4J_* env missing"); process.exit(2); }
  const csv = process.env.GUESTS_CSV;
  if (!csv) { console.error("GuestsCsvMissing: set GUESTS_CSV"); process.exit(2); }
  let guests = loadGuests(csv);
  const filter = process.env.GUESTS_FILTER?.split(",").map(s => s.trim());
  if (filter?.length) guests = guests.filter(g => filter.includes(g.guestId));
  const failures: string[] = [];
  for (const g of guests) {
    try {
      await dispatch("ingest_guest_v2", {
        person: { id: g.personId, name: g.name, position: g.title },
        school: g.school, company: g.company, place: place(g.hometown),
        inspiration: g.answers.inspiration ? g.answers.inspiration.slice(0, 80) : null,
        party: DEFAULT_PARTY,
      }, { src: "csv:la-intern-party", actor: "pipeline" });
    } catch (e) { failures.push(`${g.personId}: ${(e as Error).message}`); }
  }
  const res = await run("MATCH (p:Person) RETURN count(p) AS n", {});
  const total = toNum(res.records[0].get("n"));
  console.log(`ingested ${guests.length - failures.length}/${guests.length}; Person count in graph (all sources): ${total}`);
  if (failures.length) { console.error("FAILURES:\n" + failures.join("\n")); process.exit(1); }
  await close();
}
main();
```

(The count query is informational; the golden gate is the next step's assertions.)

- [ ] **Step 2: Golden run first** — resolve the golden guest_ids: `GUESTS_CSV=… npx tsx -e 'import {loadGuests,GOLDEN_NAMES} from "./lib/guests"; const g=loadGuests(process.env.GUESTS_CSV!); console.log(g.filter(x=>GOLDEN_NAMES.includes(x.name)).map(x=>x.guestId).join(","))'` then `GUESTS_CSV=… GUESTS_FILTER=<ids> npx tsx scripts/ingest-guests.ts`. Expect `ingested 10/10`. Verify in Neo4j through the gate's read side or `run`: TJ has `WORKS_AT` → company containing "AEFH", Crystal has NO `WORKS_AT`, Keona has `FROM` → "Pahoa".
- [ ] **Step 3: Full run** — same command without `GUESTS_FILTER`. Expect `ingested 312/312`.
- [ ] **Step 4: Conformance** — `npx tsx scripts/check-conformance.ts` → exit 0 (0 off-ontology labels/rels, 0 missing provenance).
- [ ] **Step 5: Commit** — `git add scripts/ingest-guests.ts && git commit -m "feat(graph): guest ingest through the gate — 312 people, golden-sample filter"`

---

### Task 4: Conviction extraction — batched guarded gateway pass

**Files:**
- Create: `lib/conviction.ts`, `scripts/enrich-convictions.ts`
- Test: golden-run assertions in step 3

**Interfaces:**
- Consumes: `Guest` (Task 2); `chat` + `DEFAULT_CHAT_MODEL` + `isGatewayConfigured` from `lib/gateway.ts` (mirror `scripts/extract-interests.ts` batching, BATCH=20).
- Produces:
```ts
export interface Conviction { motive: string | null; mission: string | null; impact: string | null; aspiration: string | null; quotes: Record<string, string>; openSeeker: boolean; }
export async function extractConvictions(guests: Guest[]): Promise<Map<string, Conviction>>; // keyed by personId
```
Writes `data/graph-private/convictions.json` (gitignored) so downstream tasks don't re-spend calls.

- [ ] **Step 1: Implement.** Tag vocabularies are closed zod enums (guard = grounding): motive ∈ {family-industry, childhood-immersion, escape, fandom-turned-maker, representation-gap, craft-obsession, music-first, games-first, community-belonging, storytelling-urge, performance-joy, accident-pivot}; mission ∈ {representation-feel-seen, joy-positivity, preserve-stories, build-community, elevate-underdogs, truth-inform, wonder-escape, craft-excellence, prove-its-possible, inspire-next-gen, champion-artists}; impact ∈ {make-people-feel-seen, bring-joy, create-escape-wonder, connect-people, provoke-thought, keep-stories-alive, inspire-action, inform-truth, comfort-heal}; aspiration ∈ {direct, produce, write, edit, act, compose-music, design, represent-agency, market-brand, journalism, games, executive-pm, photography, casting, cinematography, entertainment-law, undecided}. Batch schema:

```ts
const ItemSchema = z.object({
  personId: z.string(),
  motive: z.enum(MOTIVES).nullable(), mission: z.enum(MISSIONS).nullable(),
  impact: z.enum(IMPACTS).nullable(), aspiration: z.enum(ASPIRATIONS).nullable(),
  quotes: z.record(z.string()).default({}),
  openSeeker: z.boolean(),
});
const BatchSchema = z.object({ items: z.array(ItemSchema) });
```

Prompt per batch: the four answers + title per guest; rules: null when unevidenced, quotes must be verbatim substrings ≤15 words, `openSeeker` true when the seeking answer is generic ("anyone/everyone/all/open/like-minded" with no role noun). **Post-guard in code (fail loud, no silent fallback):** every returned quote must satisfy `guest.answers[field].includes(quote)` after whitespace-normalization; a violating item gets one retry for its batch, then that guest gets all-null conviction + flag `conviction-guard-failed`. Deterministic backstop for `openSeeker` (regex `/\b(anyone|everyone|everybody|all kinds|open to)\b/i`) ORed with the model's answer.

- [ ] **Step 2: Script wrapper** `scripts/enrich-convictions.ts`: DEGRADED exit 2 without gateway creds; supports `GUESTS_FILTER`; writes `data/graph-private/convictions.json`; add `data/graph-private/` to `.gitignore` (file edit, allowed — it's not `.env*`/`package.json`).
- [ ] **Step 3: Golden run + assertions** — run with the golden filter, then assert with `npx tsx -e`: Michael Vainshtein's aspiration === "casting"; Kayla McIntyre's aspiration === "compose-music"; every non-null quote is a substring of the guest's answers (re-verify in the assertion, independently of the guard); ≥6 of 10 have non-null motive.
- [ ] **Step 4: Full run** — all 312; print coverage table (expect motive ≈85–92%, mission ≈25–33%, impact ≈28–36% from the sweep's measurements; investigate if wildly off).
- [ ] **Step 5: Commit** — `git add lib/conviction.ts scripts/enrich-convictions.ts .gitignore && git commit -m "feat(graph): conviction extraction — closed-vocab guarded pass with verbatim-quote receipts"`

---

### Task 5: Matches — embeddings, seek matrix, doppelgängers, SEEKS writes

**Files:**
- Create: `lib/matches.ts`, `scripts/enrich-matches.ts`
- Test: the TJ↔Michael acceptance assertion (step 3)

**Interfaces:**
- Consumes: `Guest`, `Conviction`; `embed` from `lib/gateway.ts`; `dispatch("write_seek_edge", …)` (Task 1).
- Produces:
```ts
export interface SeekEdge { from: string; to: string; score: number; mutual: boolean; via: string; }
export interface Doppel { a: string; b: string; score: number; }
export async function computeMatches(guests: Guest[], conv: Map<string, Conviction>): Promise<{ seeks: SeekEdge[]; doppels: Doppel[] }>;
```
Caches embeddings at `data/graph-private/embeddings.json` keyed by sha256(personId + text).

- [ ] **Step 1: Implement `lib/matches.ts`.**
  - Offer doc per guest: `${title}. ${goal}` (plus `aspiration` tag spelled out). Seek doc: the seeking answer. Embed both for all guests (batch through `embed`, order-preserving).
  - Cosine matrix seek×offer. Exclusions: self; `openSeeker === true` guests produce NO outbound edges (remain inbound-eligible); pairs sharing school AND company are kept (seeking a colleague is fine) — no exclusion here beyond self.
  - Threshold: keep top-5 outbound per seeker with score ≥ the 90th percentile of that seeker's row (adaptive, no magic constant); mutual = both directions survive.
  - `via` = `"seeks " + (conv.get(to)?.aspiration ?? "their craft").replace(/-/g, " ")` — deterministic, no LLM.
  - Doppelgänger: nearest goal-embedding neighbor sharing NO school, NO company, and different signup-burst (skip burst check in v1 — school/company only), one per person, score recorded.
- [ ] **Step 2: Script** `scripts/enrich-matches.ts`: loads guests + convictions, computes, writes every seek edge through `dispatch("write_seek_edge", {from, to, score, mutual, via}, {src: "gateway:seek-match", actor: "agent"})`, and saves `data/graph-private/matches.json`.
- [ ] **Step 3: Acceptance run (full 312)** — after run, assert via `npx tsx -e`: the edge TJ Jalloh → Michael Vainshtein exists in `matches.json` OR Michael → TJ does, and at least one MUTUAL pair exists overall in the room; total seek edges between 400 and 2000; zero outbound edges from openSeeker guests. If TJ↔Michael is absent, print both directions' scores and tune ONLY the percentile constant (document the final value in the file header comment).
- [ ] **Step 4: Conformance again** — `npx tsx scripts/check-conformance.ts` exit 0 (SEEKS edges carry provenance).
- [ ] **Step 5: Commit** — `git add lib/matches.ts scripts/enrich-matches.ts && git commit -m "feat(graph): seek matrix + doppelgangers — adaptive threshold, open-seeker class, gate-written SEEKS"`

---

### Task 6: Emit — `public/graph/graph.json` + per-person records with dignity floor

**Files:**
- Create: `scripts/emit-graph.ts`, `lib/layout.ts`
- Test: `scripts/check-graph-emit.ts` (new)

**Interfaces:**
- Consumes: guests, convictions, matches (private JSONs), Neo4j via `run` (read WORKS_AT/STUDIES_AT/SEEKS back — the emitted graph must reflect the GRAPH, not the in-memory data).
- Produces (the route's contract):
```ts
// public/graph/graph.json
{ nodes: Array<{ id: string; name: string; title: string; school: string | null; company: string | null; free: boolean;
    motive: string | null; mission: string | null; impact: string | null; asp: string | null; deg: number;
    pos: { web: [number, number]; why: [number, number]; seek: [number, number] } }>,
  edges: Array<{ s: string; t: string; type: "school" | "company" | "why" | "seek"; via: string; m?: boolean; score?: number }>,
  meta: { people: number; built: string; counts: Record<string, number> } }
// public/graph/people/<personId>.json — adds answers (goal/drew/seeking/inspiration/favorite),
// ranked edges with receipts {yours:{field,quote}, theirs:{field,quote}}, highlights[]
```
- `lib/layout.ts`: `webLayout(nodes, edges): Map<string, [number, number]>` — port `simTick` from the prototype HTML, seeded PRNG (mulberry32(0x5eed)), 300 fixed ticks; `ringLayout(nodes, key): Map<string, [number, number]>` — port from prototype.

- [ ] **Step 1: Write the failing check**

```ts
// scripts/check-graph-emit.ts
import { readFileSync, readdirSync } from "node:fs";
const fail = (m: string) => { console.error("FAIL:", m); process.exit(1); };
const g = JSON.parse(readFileSync("public/graph/graph.json", "utf8"));
if (g.nodes.length !== 312) fail(`nodes ${g.nodes.length} !== 312`);
const raw = readFileSync("public/graph/graph.json", "utf8");
if (/@|\bgmail\b|\.edu\b|\+1\d{9}|luma\.com/.test(raw)) fail("PII tripwire hit in graph.json");
if (raw.length > 900_000) fail(`graph.json too big: ${raw.length}`);
const people = readdirSync("public/graph/people");
if (people.length !== 312) fail(`people files ${people.length} !== 312`);
for (const f of people) {
  const p = JSON.parse(readFileSync(`public/graph/people/${f}`, "utf8"));
  if (!p.edges?.length) fail(`dignity floor: ${f} has 0 edges`);
  if ((p.highlights?.length ?? 0) < 3) fail(`dignity floor: ${f} has <3 highlights`);
  const ANSWER_FIELDS = new Set(["goal", "drew", "seeking", "inspiration", "favorite"]);
  for (const e of p.edges)
    if (e.receipt?.yours && ANSWER_FIELDS.has(e.receipt.yours.field) &&
        !(p.answers[e.receipt.yours.field] ?? "").includes(e.receipt.yours.quote))
      fail(`receipt quote not verbatim in ${f}`);
  // school/company receipts quote raw cells, not answers — the Task 7 audit verifies those against the CSV.
}
console.log(`emit OK: 312 nodes, ${g.edges.length} edges, ${people.length} person files`);
```

- [ ] **Step 2: Run — expect FAIL** (no files yet).
- [ ] **Step 3: Implement `scripts/emit-graph.ts`.** Read structural edges from Neo4j (`MATCH (a:Person)-[:STUDIES_AT]->(s:School)<-[:STUDIES_AT]-(b:Person) WHERE a.id < b.id RETURN a.id, b.id, s.name` capped per the prototype's ring+chord sampling for groups >6; same for Company; `MATCH (a)-[k:SEEKS]->(b) RETURN a.id, b.id, k.score, k.mutual, k.via`). Why-edges: pairs sharing mission or impact tag, nearest-2 per person (from convictions). Compute `pos` with `lib/layout.ts` (web = seeded sim; why = ringLayout by motive; seek = ringLayout by aspiration). Person records: verbatim answers; ranked edges (mutual seek > inbound seek > outbound seek > why > company > school) each with receipts — school/company receipts quote the raw cells; why receipts quote the conviction quotes; seek receipts quote seeker's seeking + target's `title — goal`. Highlights (all positive-or-neutral, emit-condition enforced): `sought-by` only when inbound ≥1; `one-of-N` for school/company groups ≥2; `conviction-caucus` when mission tag group ≥3; `hometown` fact always ("came from X"); pad with `motive` fact ("one of 57 who came to this through fandom") so every record clears ≥3.
- [ ] **Step 4: Run emit + check — expect PASS** — `GUESTS_CSV=… npx tsx scripts/emit-graph.ts && npx tsx scripts/check-graph-emit.ts` → `emit OK`.
- [ ] **Step 5: Commit** — `git add scripts/emit-graph.ts lib/layout.ts scripts/check-graph-emit.ts public/graph && git commit -m "feat(graph): emit baked artifacts — per-lens positions, receipts, dignity floor, PII tripwire"`
  (public/graph is committed deliberately: names/titles/schools/companies/answers only — the same fields the party surface shows.)

---### Task 7: Audit leg — `scripts/audit-graph.ts` (must be able to FAIL)

**Files:**
- Create: `scripts/audit-graph.ts`

**Interfaces:**
- Consumes: `public/graph/*`, the CSV (`GUESTS_CSV`), Neo4j `run`.

- [ ] **Step 1: Implement three obligations.** (1) **Span integrity**: for every person file, every receipt quote is byte-identical (whitespace-normalized) to the named guest's named CSV field — re-load via `loadGuests`, compare; receipts cite personId, resolved to guestId internally. (2) **Count integrity**: re-derive every numeric highlight (`one-of-N`, `sought-by N`, caucus size) by independent recount over graph.json and compare exactly. (3) **Graph integrity**: every `seek` edge in graph.json exists as a SEEKS rel in Neo4j with matching mutual flag (`run` a parameterized query per 100-edge batch); every node id exists as a Person. Also re-assert the PII tripwire and dignity floor. Exit 1 on ANY violation with a named list; exit 2 with `GuestsCsvMissing`/`Neo4jNotConfigured` when inputs are absent.
- [ ] **Step 2: Prove it can fail** — temporarily corrupt one quote in one person file (`sed` a character), run → expect exit 1 naming that file; restore the file (`git checkout -- public/graph`), run → exit 0.
- [ ] **Step 3: Commit** — `git add scripts/audit-graph.ts && git commit -m "feat(graph): receipts audit — span/count/graph integrity, fail-able by construction"`

---

### Task 8: The `/graph` route — 3 lenses, spotlight, receipts

**Files:**
- Create: `app/graph/page.tsx`, `app/graph/GraphLab.tsx`, `app/graph/graph.module.css`
- Test: build + manual checklist (step 4)

**Interfaces:**
- Consumes: `public/graph/graph.json` + `public/graph/people/<id>.json` via client `fetch("/graph/graph.json")` (relative — works in dev and static export). No API routes, no query params; deep link via `location.hash` = personId.
- Port source: the prototype at the scratchpad path in Reference material — `draw`, `pick`, camera/pointer/pinch handlers, `select`/`rankEdges`, `openReceipt`, tab tween — translated into one `"use client"` component with `useRef`/`useEffect` (no per-frame React state; the canvas loop is imperative exactly like `app/universe/UniverseGraph.tsx`).

- [ ] **Step 1: `page.tsx`** — mirror `app/universe/page.tsx`'s structure: imports `@/passport/tokens.css` and `./graph.module.css`, `dynamic(() => import("./GraphLab"), { ssr: false })`, header with the three mono tab buttons + search + legend as DOM (module CSS reusing token vars), `export const dynamic_ = undefined` — no route handlers; ensure `output: export` compatibility (no `searchParams`).
- [ ] **Step 2: `GraphLab.tsx`** — port the prototype's script section function-for-function; replace the embedded `DATA` with `useEffect` fetch of `/graph/graph.json`; person-file fetch on select (`/graph/people/${id}.json`); positions come from `node.pos[lens]` (NO client sim — the emit script baked them; keep only the tween). Colors via `getComputedStyle(document.documentElement).getPropertyValue("--usp-spectrum-N")` per `app/universe/lib/palette.ts` convention. On mount: `if (location.hash.length > 1) select(location.hash.slice(1))`.
- [ ] **Step 3: Build gates** — `npx tsc --noEmit` clean; `npm run dev` → open `http://localhost:3000/graph`; `STATIC_EXPORT=1 npx next build` succeeds and `out/graph.html` + `out/graph/graph.json` exist.
- [ ] **Step 4: Manual checklist (Johnny at the screen)** — search "Michael Vainshtein" → spotlight + ranked rows; tap row → receipt with verbatim quotes; keys 1/2/3 tween the room; `/graph#<someId>` deep-link opens preselected; `/universe` still renders untouched.
- [ ] **Step 5: Commit** — `git add app/graph && git commit -m "feat(graph): /graph route — 3 lenses over baked artifacts, spotlight + receipts, hash deep links"`

---

### Task 9: Final verification + contract departure report

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-party-graph-design.md` (append a short "As built — v1" section)
- Test: the whole gate chain

- [ ] **Step 1: Run the chain** — in order, all must pass: `npx tsx scripts/check-graph-ontology.ts` · `GUESTS_CSV=… npx tsx scripts/check-guests.ts` · `npx tsx scripts/check-conformance.ts` · `npx tsx scripts/check-graph-emit.ts` · `GUESTS_CSV=… npx tsx scripts/audit-graph.ts` · `npx tsc --noEmit` · `STATIC_EXPORT=1 npx next build`.
- [ ] **Step 2: Departure report** (CLAUDE.md law e) — append to the spec: `[neutral] ontology — added Place/Inspiration/SEEKS + ingest_guest_v2/write_seek_edge beyond usp-v1's pinned set; why: the v2 guest dataset carries hometowns, inspirations, and directed seeking that the party surfaces traverse.` Plus any actual deviations discovered during implementation, each as `[good|neutral|bad] where — what + why`.
- [ ] **Step 3: Commit** — `git add docs/superpowers/specs/2026-07-25-party-graph-design.md && git commit -m "docs(graph): as-built notes + usp-v1 departure report"`

---

## Deferred to wave 2 (explicitly NOT in this plan)

Echo n-gram mining, signup-wave cliques, concierge Neo4j paths, market-report demand bars, door-moment toasts, RocketRide pipe leg for the batched calls, storyline distillation, handshake mode, check-ship/README/SUBMISSION updates. Each lands as its own small plan once v1 is on screen.
