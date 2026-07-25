/**
 * lib/matches.ts — the seek matrix: who each guest should find tonight, and why.
 *
 * Two documents per guest, embedded through the Butterbase gateway:
 *   OFFER doc — `title. goal. Aspiration: <tag spelled out>` — what this person IS.
 *   SEEK  doc — their verbatim "what kind of people are you looking to connect with?" answer —
 *               what this person is LOOKING FOR.
 * Cosine(seek_i, offer_j) is therefore an asymmetric matrix: "does j answer what i asked for?".
 * That asymmetry is the whole point — a MUTUAL pair (both directions survive) is a genuinely
 * rare, genuinely earned thing, not a symmetric-similarity artifact.
 *
 * THE OPEN-SEEKER CLASS. A guest whose `seeking` answer is generic ("anyone", "everyone") is
 * tagged `openSeeker` by the conviction pass. They emit NO outbound edges — an edge built on
 * "anyone" is a lie with a receipt attached — but they stay fully INBOUND-eligible: other people
 * can and should be pointed at them. Same treatment for a blank `seeking` answer (nothing to
 * embed). Self is the only pair exclusion: sharing a school AND a company with someone you
 * asked for is not a reason to hide them (seeking a colleague is fine).
 *
 * THE THRESHOLD IS ADAPTIVE, NOT A MAGIC CONSTANT. Every seeker's row gets its own floor: the
 * {@link SEEK_PERCENTILE}th percentile of THAT seeker's own candidate scores (self excluded,
 * linear-interpolated percentile). Someone whose answer is close to everyone gets a high floor;
 * someone whose answer is close to nobody still gets their best match (the row max always clears
 * its own p90), so nobody in the room is edgeless. On top of the floor, a hard {@link SEEK_TOP_K}
 * cap per seeker.
 *
 * FINAL PERCENTILE VALUE: 0.90 (the brief's starting value; unchanged). Note the arithmetic on a
 * 312-guest room: p90 of 311 candidates keeps ~31, so the TOP-K cap is what actually binds and the
 * percentile floor only binds in small rooms (a 10-guest golden run keeps ~1 candidate per seeker).
 * Lowering the percentile below ~0.984 cannot add edges — the cap eats them. This is deliberate:
 * the user's balance directive is a legible graph, so out-degree is bounded at 5 by construction
 * (≈194 seekers × ≤5 ≈ 970 edges for the real party), never an uncapped matrix dump.
 *
 * DOPPELGÄNGER — the "how does it know?" beat. Nearest OFFER-embedding neighbour who shares NO
 * school and NO company: the same person, arrived at from somewhere else entirely. One per person
 * (reciprocal pairs stored once), saved to matches.json only — doppels are NOT written to Neo4j
 * (there is no manifest action for them, and law (a) means no action ⇒ unrepresentable).
 *
 * EMBEDDING CACHE — `data/graph-private/embeddings.json`, keyed by sha256(personId + text), so a
 * re-run re-spends nothing. The cache records the embedding model; a model change invalidates the
 * whole file rather than silently mixing vector spaces.
 *
 * LAWS: (b) DEGRADED is never faked — `GatewayNotConfigured` propagates untouched, cacheOnly mode
 * throws the named {@link EmbeddingsCacheMiss} instead of inventing vectors, and every embedding
 * batch passes {@link assertUsableVectors} before it can reach the cache. (a)/(d) the
 * SEEKS writes live in scripts/enrich-matches.ts and go through the gate only. (c) every edge
 * carries `via`, derived from the target's own conviction tag — deterministic, no LLM in this file.
 *
 * DEPARTURES (law e):
 *   [neutral] the brief's "goal-embedding" for doppelgängers IS the offer doc (title + goal +
 *     aspiration) — no third embedding pass, half the spend, same signal.
 *   [neutral] a guest with a BLANK `seeking` answer is treated like an openSeeker (no outbound):
 *     the brief only names openSeeker, but there is no document to embed.
 *   [neutral] the brief's doppelgänger "different signup-burst" rule is skipped per its own v1 note.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { embed, DEFAULT_EMBED_MODEL } from "./gateway";
import type { Guest } from "./guests";
import type { Conviction } from "./conviction";

// ---------------------------------------------------------------------------
// Constants (all tunable knobs live here, none inline).
// ---------------------------------------------------------------------------

/** Where the computed matrix is cached for the emit leg. */
export const MATCHES_PATH = "data/graph-private/matches.json";
/** Where raw vectors are cached so re-runs cost nothing. */
export const EMBEDDINGS_PATH = "data/graph-private/embeddings.json";
/** Per-row adaptive floor. See the header note on why this binds only in small rooms. */
export const SEEK_PERCENTILE = 0.9;
/** Hard outbound cap per seeker — the user's balance directive, enforced by construction. */
export const SEEK_TOP_K = 5;
/** Texts per gateway embedding call. */
export const EMBED_BATCH = 64;
/** Fallback offer text for a guest with no title and no goal — never embed an empty string. */
export const OFFER_FALLBACK = "creative";
/**
 * Anything narrower than this is not an embedding. Real models are 768–3072d; a 2d "vector" is
 * what you get when a base64-decode goes wrong upstream (openai@5 requests `encoding_format:
 * base64` and decodes unconditionally, so a gateway that answers with a plain float array
 * decodes to a couple of denormal zeros). Cosines over that garbage are silently meaningless —
 * exactly the failure the fail-loud law exists to prevent.
 */
export const MIN_EMBED_DIM = 16;

// ---------------------------------------------------------------------------
// Shapes.
// ---------------------------------------------------------------------------

export interface SeekEdge {
  from: string;
  to: string;
  score: number;
  mutual: boolean;
  via: string;
}

export interface Doppel {
  a: string;
  b: string;
  score: number;
}

export interface Matches {
  seeks: SeekEdge[];
  doppels: Doppel[];
}

/** School/company for the doppelgänger eligibility test — the only guest fields it reads. */
export interface DoppelMeta {
  school: string | null;
  company: string | null;
}

export interface MatchOptions {
  /** Per-row percentile floor. Default {@link SEEK_PERCENTILE}. */
  percentile?: number;
  /** Outbound cap per seeker. Default {@link SEEK_TOP_K}. */
  topK?: number;
  /** DRY_RUN: never touch the gateway — every doc must already be cached, else throw. */
  cacheOnly?: boolean;
  /** Override the embedding cache path (tests / alternate runs). */
  embedPath?: string;
  /** Progress sink. Default `console.log`. */
  log?: (msg: string) => void;
  /**
   * Diagnostics hook — handed the index-aligned vectors just before selection, so a caller can
   * print RAW pair scores for named guests (the acceptance step's "print both directions'
   * scores"). Read-only by contract; it never changes what gets built.
   */
  onVectors?: (v: { ids: string[]; seekVecs: Array<number[] | null>; offerVecs: number[][] }) => void;
}

/** cacheOnly mode hit a doc that was never embedded. Named so the caller can exit cleanly. */
export class EmbeddingsCacheMiss extends Error {
  readonly missing: number;
  readonly total: number;
  constructor(missing: number, total: number, path: string) {
    super(
      `EmbeddingsCacheMiss: ${missing}/${total} document(s) are not in ${path}. ` +
        `DRY_RUN cannot embed (that would need the gateway) — run the live pass once to fill the cache.`,
    );
    this.name = "EmbeddingsCacheMiss";
    this.missing = missing;
    this.total = total;
  }
}

/** The gateway answered, but with something that cannot be an embedding. Never cached, never used. */
export class EmbeddingsDegenerate extends Error {
  constructor(detail: string, model: string) {
    super(
      `EmbeddingsDegenerate: ${detail} (model "${model}"). Refusing to build a match matrix out of ` +
        `unusable vectors — check the gateway's embedding response encoding before re-running.`,
    );
    this.name = "EmbeddingsDegenerate";
  }
}

/**
 * The deterministic guard on the embedding call (law b): a returned batch must be rectangular,
 * wide enough to be a real embedding, finite, and non-zero. Anything else fails LOUD instead of
 * quietly producing a room where every cosine is 0 and every match is arbitrary.
 */
export function assertUsableVectors(vs: ReadonlyArray<number[]>, model: string = DEFAULT_EMBED_MODEL): void {
  if (vs.length === 0) return;
  const dim = vs[0].length;
  if (dim < MIN_EMBED_DIM) {
    throw new EmbeddingsDegenerate(`vectors are ${dim}-dimensional, expected >= ${MIN_EMBED_DIM}`, model);
  }
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i];
    if (v.length !== dim) {
      throw new EmbeddingsDegenerate(`ragged batch — vector ${i} is ${v.length}d, vector 0 is ${dim}d`, model);
    }
    let n = 0;
    for (const x of v) {
      if (!Number.isFinite(x)) throw new EmbeddingsDegenerate(`vector ${i} contains a non-finite value`, model);
      n += x * x;
    }
    if (n === 0) throw new EmbeddingsDegenerate(`vector ${i} is all zeros`, model);
  }
}

// ---------------------------------------------------------------------------
// Documents (pure).
// ---------------------------------------------------------------------------

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** What this person is looking for — their own words, or "" when they wrote nothing. */
export function seekDoc(g: Guest): string {
  return oneLine(g.answers.seeking ?? "");
}

/** What this person IS: title, goal, and the aspiration tag spelled out ("represent-agency" → "represent agency"). */
export function offerDoc(g: Guest, c?: Conviction | null): string {
  const parts: string[] = [];
  const title = oneLine(g.title ?? "");
  const goal = oneLine(g.answers.goal ?? "");
  if (title) parts.push(title);
  if (goal) parts.push(goal);
  if (c?.aspiration) parts.push(`Aspiration: ${c.aspiration.replace(/-/g, " ")}`);
  return oneLine(parts.join(". ")) || OFFER_FALLBACK;
}

/**
 * The edge label — the brief's pinned rule, verbatim: the TARGET's aspiration tag, spelled out.
 * Deterministic, no LLM: "seeks casting", "seeks compose music", "seeks their craft".
 */
export function viaFor(toId: string, conv: Map<string, Conviction>): string {
  return `seeks ${(conv.get(toId)?.aspiration ?? "their craft").replace(/-/g, " ")}`;
}

/** True when this guest may emit OUTBOUND edges: not an openSeeker, and they actually wrote something. */
export function isOutboundSeeker(g: Guest, c?: Conviction | null): boolean {
  if (c?.openSeeker) return false;
  return seekDoc(g) !== "";
}

// ---------------------------------------------------------------------------
// Math (pure — the whole selection rule is testable without a gateway).
// ---------------------------------------------------------------------------

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Artifact-stable score: clamped into the gate's 0..1 param range, 4 decimals. */
export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** rows × cols cosine matrix. `out[i][j] = cosine(rows[i], cols[j])`. */
export function cosineMatrix(rows: ReadonlyArray<number[]>, cols: ReadonlyArray<number[]>): number[][] {
  return rows.map((r) => cols.map((c) => cosine(r, c)));
}

/**
 * Linear-interpolated percentile (numpy's default method) over an unsorted sample.
 * `p` is a fraction in [0,1]. Empty sample → NaN (callers must not build edges from it).
 */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const q = p < 0 ? 0 : p > 1 ? 1 : p;
  const idx = (s.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/**
 * The per-seeker floor: the p-th percentile of that seeker's OWN candidate scores.
 * Pass the row with self already excluded — self-similarity is 1.0 and would drag the floor up.
 */
export function adaptiveThreshold(row: ReadonlyArray<number>, p: number = SEEK_PERCENTILE): number {
  return percentile(row, p);
}

const KEY = (from: string, to: string): string => `${from}|${to}`;

/** The set of `from|to` keys whose reverse direction also survived — i.e. the mutual edges. */
export function mutualOf(edges: ReadonlyArray<Pick<SeekEdge, "from" | "to">>): Set<string> {
  const present = new Set(edges.map((e) => KEY(e.from, e.to)));
  const mutual = new Set<string>();
  for (const e of edges) {
    if (present.has(KEY(e.to, e.from))) mutual.add(KEY(e.from, e.to));
  }
  return mutual;
}

/** Copy of `edges` with `mutual` set per {@link mutualOf}. */
export function markMutual(edges: ReadonlyArray<SeekEdge>): SeekEdge[] {
  const mutual = mutualOf(edges);
  return edges.map((e) => ({ ...e, mutual: mutual.has(KEY(e.from, e.to)) }));
}

/**
 * THE SELECTION RULE, pure and index-aligned.
 *
 * @param ids        personIds; index i is the same person in every array.
 * @param seekVecs   seek vector per person, or `null` for "emits no outbound edges"
 *                   (openSeeker / blank seeking answer). Still inbound-eligible via offerVecs.
 * @param offerVecs  offer vector per person — every person has one.
 * @param via        deterministic edge label, given the TARGET's personId.
 *
 * Per seeker: score every other person (self is the only exclusion), keep those at or above the
 * row's adaptive threshold, take the best `topK` (ties broken by personId, so the output is a
 * deterministic function of the inputs), then flag the pairs that survived both ways.
 */
export function buildSeekEdges(
  ids: ReadonlyArray<string>,
  seekVecs: ReadonlyArray<number[] | null>,
  offerVecs: ReadonlyArray<number[]>,
  via: (toId: string) => string,
  opts: { percentile?: number; topK?: number } = {},
): SeekEdge[] {
  if (seekVecs.length !== ids.length || offerVecs.length !== ids.length) {
    throw new Error(
      `buildSeekEdges: length mismatch — ids=${ids.length} seek=${seekVecs.length} offer=${offerVecs.length}`,
    );
  }
  const p = opts.percentile ?? SEEK_PERCENTILE;
  const topK = opts.topK ?? SEEK_TOP_K;

  const seekerIdx = ids.map((_, i) => i).filter((i) => seekVecs[i] !== null);
  const matrix = cosineMatrix(
    seekerIdx.map((i) => seekVecs[i] as number[]),
    offerVecs,
  );

  const edges: SeekEdge[] = [];
  for (let r = 0; r < seekerIdx.length; r++) {
    const i = seekerIdx[r];
    const row = matrix[r];
    const cand: Array<{ j: number; score: number }> = [];
    for (let j = 0; j < ids.length; j++) {
      if (j === i) continue; // self — the ONLY exclusion
      cand.push({ j, score: row[j] });
    }
    if (cand.length === 0) continue;

    const thr = adaptiveThreshold(cand.map((c) => c.score), p);
    const kept = cand
      .filter((c) => c.score >= thr)
      .sort((a, b) => b.score - a.score || (ids[a.j] < ids[b.j] ? -1 : ids[a.j] > ids[b.j] ? 1 : 0))
      .slice(0, topK);

    for (const c of kept) {
      edges.push({
        from: ids[i],
        to: ids[c.j],
        score: round4(clamp01(c.score)),
        mutual: false,
        via: via(ids[c.j]),
      });
    }
  }
  return markMutual(edges);
}

/**
 * One doppelgänger per person: nearest offer-embedding neighbour who shares NO school and NO
 * company (null never counts as "shared" — two freelancers are not colleagues). Reciprocal picks
 * are stored once, so each personId appears as `a` at most once and the artifact stays legible.
 */
export function pickDoppels(
  ids: ReadonlyArray<string>,
  vecs: ReadonlyArray<number[]>,
  meta: ReadonlyArray<DoppelMeta>,
): Doppel[] {
  if (vecs.length !== ids.length || meta.length !== ids.length) {
    throw new Error(`pickDoppels: length mismatch — ids=${ids.length} vecs=${vecs.length} meta=${meta.length}`);
  }
  const shares = (x: string | null, y: string | null): boolean => x !== null && y !== null && x === y;

  const out: Doppel[] = [];
  const seenPair = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    let best = -Infinity;
    let bestJ = -1;
    for (let j = 0; j < ids.length; j++) {
      if (j === i) continue;
      if (shares(meta[i].school, meta[j].school)) continue;
      if (shares(meta[i].company, meta[j].company)) continue;
      const s = cosine(vecs[i], vecs[j]);
      // ties broken by personId so the pick is a deterministic function of the inputs
      if (s > best || (s === best && bestJ >= 0 && ids[j] < ids[bestJ])) {
        best = s;
        bestJ = j;
      }
    }
    if (bestJ < 0) continue; // everyone eligible shares a school or a company with them
    const pair = ids[i] < ids[bestJ] ? KEY(ids[i], ids[bestJ]) : KEY(ids[bestJ], ids[i]);
    if (seenPair.has(pair)) continue; // reciprocal nearest-neighbours — record the pair once
    seenPair.add(pair);
    out.push({ a: ids[i], b: ids[bestJ], score: round4(clamp01(best)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Embedding cache.
// ---------------------------------------------------------------------------

export interface EmbedCache {
  model: string;
  dim: number;
  vectors: Record<string, number[]>;
}

export interface EmbedDoc {
  personId: string;
  text: string;
}

/** The brief's pinned cache key: sha256(personId + text). */
export function cacheKey(personId: string, text: string): string {
  return createHash("sha256").update(personId + text).digest("hex");
}

/** Read the cache, or null when absent/unreadable/malformed (a bad cache is simply no cache). */
export function loadEmbedCache(path: string = EMBEDDINGS_PATH): EmbedCache | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<EmbedCache>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.vectors !== "object" || parsed.vectors === null) {
      return null;
    }
    return {
      model: typeof parsed.model === "string" ? parsed.model : "unknown",
      dim: typeof parsed.dim === "number" ? parsed.dim : 0,
      vectors: parsed.vectors as Record<string, number[]>,
    };
  } catch {
    return null;
  }
}

export function saveEmbedCache(cache: EmbedCache, path: string = EMBEDDINGS_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache), "utf8");
}

/**
 * Vectors for `docs`, in order, reading the cache first and embedding only the misses.
 *
 * A model change invalidates the whole file (mixing two vector spaces would silently produce
 * garbage cosines). The cache is flushed in a `finally`, so a gateway failure mid-run still keeps
 * everything already paid for.
 *
 * @throws EmbeddingsCacheMiss when `cacheOnly` and a doc is not cached (DRY_RUN).
 * @throws GatewayNotConfigured / GatewayError untouched — DEGRADED is never laundered.
 */
export async function embedWithCache(
  docs: ReadonlyArray<EmbedDoc>,
  opts: { cacheOnly?: boolean; path?: string; log?: (m: string) => void } = {},
): Promise<{ vectors: number[][]; hits: number; embedded: number }> {
  const path = opts.path ?? EMBEDDINGS_PATH;
  const log = opts.log ?? console.log;
  const model = DEFAULT_EMBED_MODEL;

  let cache = loadEmbedCache(path);
  if (cache && cache.model !== model) {
    log(`embed cache: model changed (${cache.model} → ${model}) — discarding ${Object.keys(cache.vectors).length} stale vector(s)`);
    cache = null;
  }
  const vectors: Record<string, number[]> = cache ? cache.vectors : {};

  const keys = docs.map((d) => cacheKey(d.personId, d.text));
  const missingKeys: string[] = [];
  const missingTexts: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < docs.length; i++) {
    const k = keys[i];
    if (Array.isArray(vectors[k]) || seen.has(k)) continue;
    seen.add(k);
    missingKeys.push(k);
    missingTexts.push(docs[i].text);
  }

  if (missingKeys.length && opts.cacheOnly) {
    throw new EmbeddingsCacheMiss(missingKeys.length, docs.length, path);
  }

  let embedded = 0;
  if (missingKeys.length) {
    log(`embed: ${docs.length - missingKeys.length}/${docs.length} cached · ${missingKeys.length} to embed via ${model}`);
    try {
      for (let s = 0; s < missingTexts.length; s += EMBED_BATCH) {
        const batchKeys = missingKeys.slice(s, s + EMBED_BATCH);
        const batchTexts = missingTexts.slice(s, s + EMBED_BATCH);
        const got = await embed(batchTexts);
        if (got.length !== batchTexts.length) {
          throw new Error(`embedWithCache: gateway returned ${got.length} vectors for ${batchTexts.length} texts`);
        }
        assertUsableVectors(got, model); // guard BEFORE anything reaches the cache

        for (let k = 0; k < batchKeys.length; k++) vectors[batchKeys[k]] = got[k];
        embedded += batchKeys.length;
        log(`  …embedded ${embedded}/${missingKeys.length}`);
      }
    } finally {
      // Whatever was paid for is kept, even if a later batch threw.
      if (embedded > 0) {
        const dim = Object.values(vectors)[0]?.length ?? 0;
        saveEmbedCache({ model, dim, vectors }, path);
      }
    }
  } else {
    log(`embed: all ${docs.length} document(s) served from ${path}`);
  }

  return { vectors: keys.map((k) => vectors[k]), hits: docs.length - missingKeys.length, embedded };
}

// ---------------------------------------------------------------------------
// computeMatches — the one call the script makes.
// ---------------------------------------------------------------------------

/**
 * Guests + convictions → the seek matrix and the doppelgänger list.
 *
 * Order is a deterministic function of `guests` (the caller's CSV order), so two runs over the
 * same cache produce byte-identical output.
 */
export async function computeMatches(
  guests: Guest[],
  conv: Map<string, Conviction>,
  opts: MatchOptions = {},
): Promise<Matches> {
  const log = opts.log ?? console.log;
  const ids = guests.map((g) => g.personId);

  const offers: EmbedDoc[] = guests.map((g) => ({
    personId: g.personId,
    text: offerDoc(g, conv.get(g.personId)),
  }));
  const outbound = guests.map((g) => isOutboundSeeker(g, conv.get(g.personId)));
  const seekers: EmbedDoc[] = [];
  for (let i = 0; i < guests.length; i++) {
    if (outbound[i]) seekers.push({ personId: guests[i].personId, text: seekDoc(guests[i]) });
  }
  log(
    `matches: ${guests.length} guest(s) · ${seekers.length} outbound seeker(s) · ` +
      `${guests.length - seekers.length} inbound-only (openSeeker / blank seeking)`,
  );

  const { vectors, hits, embedded } = await embedWithCache([...offers, ...seekers], {
    cacheOnly: opts.cacheOnly,
    path: opts.embedPath,
    log,
  });
  log(`embed: ${hits} cache hit(s), ${embedded} newly embedded`);

  const offerVecs = vectors.slice(0, offers.length);
  const seekVecList = vectors.slice(offers.length);
  const seekVecs: Array<number[] | null> = [];
  let s = 0;
  for (let i = 0; i < guests.length; i++) seekVecs.push(outbound[i] ? seekVecList[s++] : null);

  opts.onVectors?.({ ids, seekVecs, offerVecs });

  const seeks = buildSeekEdges(ids, seekVecs, offerVecs, (to) => viaFor(to, conv), {
    percentile: opts.percentile,
    topK: opts.topK,
  });
  const doppels = pickDoppels(
    ids,
    offerVecs,
    guests.map((g) => ({ school: g.school, company: g.company })),
  );

  return { seeks, doppels };
}
