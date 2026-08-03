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
 * embed). Self is the only PAIR exclusion: sharing a school AND a company with someone you
 * asked for is not a reason to hide them (seeking a colleague is fine).
 *
 * THE FALLBACK-OFFER CLASS — the mirror image (see {@link isSeekTarget}). A guest who told us
 * NOTHING gets the manufactured {@link OFFER_FALLBACK} as their offer doc; that string is our
 * word, not theirs, so it cannot make them a seek TARGET. Their own outbound seeking, if they
 * wrote one, is untouched — their words are evidence whatever their profile is missing.
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
 * TWO VECTOR PROVIDERS (`EMBED_PROVIDER`, default `gateway`).
 *   `gateway` — Butterbase embeddings, cached at `data/graph-private/embeddings.json` keyed by
 *     sha256(personId + text), so a re-run re-spends nothing. The cache records the embedding
 *     model; a model change invalidates the whole file rather than mixing two vector spaces.
 *   `tfidf` — THE NAMED FALLBACK (2026-07-25). The gateway serves no embedding model any more:
 *     its /models catalog lists 397 ids with zero embedders and every /embeddings probe answers
 *     MODEL_NOT_FOUND. Rather than fake a matrix or ship an empty one, this mode computes
 *     deterministic L2-normalized TF-IDF vectors over the room's own corpus (all offer docs + all
 *     seek docs) — pure code, no network, no cache needed. It is honestly labelled everywhere it
 *     touches: the SEEKS writes carry `_src = "match:tfidf-v1"` (law d), and the run banner says
 *     so out loud (law b: never a silent fallback). Restore the platform's embeddings and
 *     `EMBED_PROVIDER=gateway` returns to the semantic matrix with no other change.
 * Everything downstream of the vectors — thresholds, caps, mutuality, doppelgängers, diagnostics —
 * is provider-agnostic and byte-for-byte identical in both modes.
 *
 * LAWS: (b) DEGRADED is never faked — `GatewayNotConfigured` propagates untouched, cacheOnly mode
 * throws the named {@link EmbeddingsCacheMiss} instead of inventing vectors, and every embedding
 * batch passes {@link assertUsableVectors} before it can reach the cache. (a)/(d) the
 * SEEKS writes live in scripts/enrich-matches.ts and go through the gate only. (c) every edge
 * carries `via`, derived from the target's own conviction tag — deterministic, no LLM in this file.
 *
 * DEPARTURES (law e):
 *   [neutral] the brief's "goal-embedding" for doppelgängers IS the offer doc (title + goal +
 *     affiliation + aspiration) — no third embedding pass, half the spend, same signal.
 *   [good] the offer doc also carries the guest's company and school display names: under a
 *     lexical provider that is exactly the signal the seek answers ask for ("talent agency",
 *     "someone at a studio"), and under the gateway provider it is honest extra context.
 *   [neutral] a guest with a BLANK `seeking` answer is treated like an openSeeker (no outbound):
 *     the brief only names openSeeker, but there is no document to embed.
 *   [good] the brief has no inbound-eligibility rule at all — every guest is a target. That let
 *     the OFFER_FALLBACK placeholder mint demand nobody expressed; {@link isSeekTarget} closes it.
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
/** Tokens shorter than this carry no lexical signal. */
export const MIN_TOKEN_LEN = 2;
/**
 * Small English function-word list for the TF-IDF provider. Deliberately FUNCTION WORDS ONLY —
 * no "people", no "anyone", no craft nouns: those are the signal, not the noise.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // articles / prepositions / conjunctions
  "the", "and", "for", "with", "that", "this", "these", "those", "from", "into", "onto", "out",
  "off", "over", "under", "than", "then", "there", "here", "about", "of", "in", "to", "as", "at",
  "on", "by", "or", "if", "an", "so", "up", "but", "because", "while", "after", "before", "during",
  "between", "through", "within", "without", "against", "across", "toward", "towards", "upon",
  // pronouns / determiners
  "you", "your", "yours", "our", "ours", "their", "them", "they", "she", "her", "hers", "his",
  "him", "its", "it", "we", "us", "me", "my", "mine", "he", "who", "whom", "whose", "which",
  "what", "when", "where", "why", "how", "all", "any", "some", "each", "other", "others", "both",
  "few", "own", "such", "same",
  // auxiliaries / modals / light verbs
  "is", "am", "are", "was", "were", "been", "being", "be", "have", "has", "had", "having", "do",
  "does", "did", "done", "not", "no", "can", "will", "would", "could", "should", "may", "might",
  "must", "get", "got",
  // degree / discourse filler
  "just", "also", "very", "much", "more", "most", "too", "even", "still", "only", "again", "once",
  "really", "maybe", "perhaps", "lot", "lots", "one", "two", "etc",
  // apostrophe fragments (apostrophes are split points: "don't" → "don" + "t")
  "ve", "ll", "re", "im", "don", "doesn", "didn", "isn", "aren", "wasn", "weren", "couldn",
  "shouldn", "wouldn", "hasn", "haven", "hadn",
]);
/** The vector sources. `gateway` = Butterbase embeddings; `tfidf` = the named local fallback. */
export const VECTOR_PROVIDERS = ["gateway", "tfidf"] as const;
export type VectorProvider = (typeof VECTOR_PROVIDERS)[number];

/** `EMBED_PROVIDER` was set to something that is not a provider — fail loud, never guess. */
export class UnknownVectorProvider extends Error {
  constructor(raw: string) {
    super(
      `UnknownVectorProvider: EMBED_PROVIDER="${raw}" is not one of ${VECTOR_PROVIDERS.join(" | ")}. ` +
        `Refusing to guess which vector space to build the room out of.`,
    );
    this.name = "UnknownVectorProvider";
  }
}

/** Read the provider at CALL time (never import time), so a run can switch without a code change. */
export function vectorProvider(raw: string | undefined = process.env.EMBED_PROVIDER): VectorProvider {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "gateway";
  if ((VECTOR_PROVIDERS as readonly string[]).includes(v)) return v as VectorProvider;
  throw new UnknownVectorProvider(raw ?? "");
}

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
  /** Vector source. Default: {@link vectorProvider} (the `EMBED_PROVIDER` env, else `gateway`). */
  provider?: VectorProvider;
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
  onVectors?: (v: {
    ids: string[];
    seekVecs: Array<number[] | null>;
    offerVecs: number[][];
    /** index-aligned inbound eligibility — a diagnostic that ranked against ineligible targets
     *  would print a floor and a rank the selection never used. */
    targetable: boolean[];
  }) => void;
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
 * The deterministic guard on the vector set (law b): rectangular, wide enough, finite, non-zero.
 * Anything else fails LOUD instead of quietly producing a room where every cosine is 0 and every
 * match is arbitrary.
 *
 * Run over the FULL ASSEMBLED SET before any matrix math — not just over freshly-embedded batches.
 * A cache file written by an older run (different model, truncated entry, hand-edited) is exactly
 * as dangerous as a bad gateway response, and DRY_RUN reads nothing BUT the cache.
 *
 * `opts.allowZero` is for the TF-IDF provider, where a document whose every token is a stopword
 * legitimately yields a zero vector; the caller handles those by name instead of dying on them.
 * `opts.minDim` likewise: a TF-IDF dimension is the corpus vocabulary, not a model property.
 */
export function assertUsableVectors(
  vs: ReadonlyArray<number[]>,
  model: string = DEFAULT_EMBED_MODEL,
  opts: { minDim?: number; allowZero?: boolean } = {},
): void {
  if (vs.length === 0) return;
  const minDim = opts.minDim ?? MIN_EMBED_DIM;
  const dim = vs[0].length;
  if (dim < minDim) {
    throw new EmbeddingsDegenerate(`vectors are ${dim}-dimensional, expected >= ${minDim}`, model);
  }
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i];
    if (!Array.isArray(v)) throw new EmbeddingsDegenerate(`entry ${i} is not a vector (${typeof v})`, model);
    if (v.length !== dim) {
      throw new EmbeddingsDegenerate(`ragged set — vector ${i} is ${v.length}d, vector 0 is ${dim}d`, model);
    }
    let n = 0;
    for (const x of v) {
      if (!Number.isFinite(x)) throw new EmbeddingsDegenerate(`vector ${i} contains a non-finite value`, model);
      n += x * x;
    }
    if (n === 0 && !opts.allowZero) throw new EmbeddingsDegenerate(`vector ${i} is all zeros`, model);
  }
}

// ---------------------------------------------------------------------------
// TF-IDF provider (pure, deterministic, offline — the named fallback).
// ---------------------------------------------------------------------------

/**
 * Fold the English plural onto its singular so a lexical space can see that "future directors" and
 * "casting director" are about the same job. Deterministic, uniform, and applied to every document
 * — never a special case for a particular pair.
 *
 * MEASURED on the full 312-guest room (tfidf), not assumed: folding takes 910 → 962 seek edges and
 * drops "sought by nobody" 78 → 70. It is also what gives the acceptance pair any shared term at
 * all — TJ Jalloh seeks "future directors", Michael Vainshtein offers "casting director" ×3, which
 * is zero overlap unfolded and 0.0253 folded (still rank 63/311, i.e. nowhere near the top-5 cap:
 * see the task report — a lexical space cannot see that those two sentences mean the same thing).
 */
export function foldPlural(t: string): string {
  if (t.length >= 5 && t.endsWith("ies")) return `${t.slice(0, -3)}y`; // stories → story
  if (t.length >= 5 && /(?:ss|sh|ch|x|z)es$/.test(t)) return t.slice(0, -2); // classes → class
  if (t.length >= 4 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us") && !t.endsWith("is")) {
    return t.slice(0, -1); // directors → director  (business/analysis left alone)
  }
  return t;
}

/**
 * lowercase → strip diacritics → split on non-alphanumerics → drop short tokens + stopwords →
 * fold plurals. Stopwords are checked BEFORE folding (the list is written in surface form) and
 * again after, so "others" → "other" cannot sneak back in.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t))
    .map(foldPlural)
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

/**
 * L2-normalized TF-IDF vectors over the corpus's own shared vocabulary.
 * `idf = ln(1 + N/df)`; `tf` = raw in-document count. Vocabulary order is sorted, so the vector
 * space — and therefore every downstream score — is a pure function of the input texts.
 *
 * A document with no surviving tokens yields the zero vector: honest ("nothing to match on"),
 * and handled by name in {@link computeMatches} rather than papered over.
 */
export function tfidfVectors(texts: ReadonlyArray<string>): number[][] {
  const docs = texts.map(tokenize);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);

  const vocab = [...df.keys()].sort(); // deterministic dimension order
  const at = new Map(vocab.map((t, i) => [t, i]));
  const n = docs.length;
  const idf = vocab.map((t) => Math.log(1 + n / (df.get(t) as number)));

  return docs.map((d) => {
    const v = new Array<number>(vocab.length).fill(0);
    for (const t of d) v[at.get(t) as number] += 1;
    let norm = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] !== 0) {
        v[i] *= idf[i];
        norm += v[i] * v[i];
      }
    }
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm);
      for (let i = 0; i < v.length; i++) if (v[i] !== 0) v[i] *= inv;
    }
    return v;
  });
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

/**
 * What this person IS: title, goal, where they actually are (company / school display names), and
 * the aspiration tag spelled out ("represent-agency" → "represent agency").
 *
 * The affiliation names earn their place: half the room's `seeking` answers ask for a KIND OF
 * PLACE ("people at agencies", "students at USC"), which no amount of title text answers.
 */
export function offerDoc(g: Guest, c?: Conviction | null): string {
  const parts: string[] = [];
  const title = oneLine(g.title ?? "");
  const goal = oneLine(g.answers.goal ?? "");
  const where = oneLine(`${g.company ?? ""} ${g.school ?? ""}`);
  if (title) parts.push(title);
  if (goal) parts.push(goal);
  if (where) parts.push(where);
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

/**
 * True when this guest may be an INBOUND (seek) TARGET: their offer document is something they
 * actually told us, and not the manufactured {@link OFFER_FALLBACK}.
 *
 * WHY THIS EXISTS. `offerDoc` never embeds an empty string, so a guest who gave us no title, no
 * goal, no company, no school and no aspiration tag is described to the matcher by the single
 * word "creative" — our placeholder, not their word. Under the lexical provider that one common
 * token appears in a large share of the room's `seeking` answers, so the emptiest profile in the
 * room scored as the room's most-sought person (48 inbound edges against 26 for the legitimate
 * runner-up). "48 people are looking for someone like you" for someone who told us nothing is a
 * demand signal our own fallback manufactured, and law (c) has no receipt to offer for it: the
 * target side of every one of those edges was already quoteless, because `craftLine` correctly
 * found nothing of theirs to quote. So the fallback offer is inbound-INELIGIBLE.
 *
 * Deliberately NOT symmetric with {@link isOutboundSeeker}: this is about what WE manufactured on
 * their behalf. Anything they wrote themselves — including their `seeking` answer — still stands.
 *
 * Uniform by construction: the test is "is this document the fallback", never a person. On the
 * 312-guest room it selects exactly one guest, and it selects the same guest as the looser
 * reading ("no real title and no real goal") — this is the tighter of the two, because a company
 * or a school IS a fact the guest gave us even when they wrote no prose.
 */
export function isSeekTarget(g: Guest, c?: Conviction | null): boolean {
  return offerDoc(g, c) !== OFFER_FALLBACK;
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

/**
 * Two vectors from different spaces reached the same cosine. Truncating to the shorter one would
 * answer with a number instead of a fault — and a wrong number here is an arbitrary edge with a
 * receipt on it. Fail loud instead.
 */
export class VectorDimensionMismatch extends Error {
  constructor(a: number, b: number) {
    super(
      `VectorDimensionMismatch: cosine over a ${a}d and a ${b}d vector. These are not the same ` +
        `vector space — refusing to truncate and return a meaningless similarity.`,
    );
    this.name = "VectorDimensionMismatch";
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new VectorDimensionMismatch(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = a.length;
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
 * @param targetable per person: may anyone be pointed AT them? `false` for a manufactured offer
 *                   doc ({@link isSeekTarget}). Omit for "everyone is targetable".
 * @param via        deterministic edge label, given the TARGET's personId.
 *
 * Per seeker: score every ELIGIBLE other person, keep those at or above the row's adaptive
 * threshold AND above zero (an edge needs some evidence), take the best `topK` (ties broken by
 * personId, so the output is a deterministic function of the inputs), then flag the pairs that
 * survived both ways.
 *
 * An ineligible target is dropped from the candidate list BEFORE the row's percentile floor is
 * computed, not filtered off the result afterwards. It is not a candidate that lost; it is not a
 * candidate. Leaving it in the sample would let a phantom high score raise the floor and suppress
 * a real edge — the fabricated signal would still be shaping the room after being hidden from it.
 */
export function buildSeekEdges(
  ids: ReadonlyArray<string>,
  seekVecs: ReadonlyArray<number[] | null>,
  offerVecs: ReadonlyArray<number[]>,
  targetable: ReadonlyArray<boolean> | null,
  via: (toId: string) => string,
  opts: { percentile?: number; topK?: number } = {},
): SeekEdge[] {
  if (seekVecs.length !== ids.length || offerVecs.length !== ids.length) {
    throw new Error(
      `buildSeekEdges: length mismatch — ids=${ids.length} seek=${seekVecs.length} offer=${offerVecs.length}`,
    );
  }
  if (targetable !== null && targetable.length !== ids.length) {
    throw new Error(`buildSeekEdges: length mismatch — ids=${ids.length} targetable=${targetable.length}`);
  }
  const canTarget = (j: number): boolean => targetable === null || targetable[j];
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
      if (j === i) continue; // self — the only PAIR exclusion
      if (!canTarget(j)) continue; // nothing of their own to be sought for (isSeekTarget)
      cand.push({ j, score: row[j] });
    }
    if (cand.length === 0) continue;

    const thr = adaptiveThreshold(cand.map((c) => c.score), p);
    const kept = cand
      // `score > 0` is the law-(c) floor under it all: a zero similarity means the two documents
      // have NOTHING in common, so the edge would be a "why" with no evidence behind it. Under a
      // dense embedding space this never fires (cosines are never exactly 0); under TF-IDF a
      // sparse row can be 90%+ zeros, and without this the percentile floor sits at 0.0 and the
      // top-K cap hands out five evidence-free edges by tie-break alone.
      .filter((c) => c.score >= thr && c.score > 0)
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
 * Order is a deterministic function of `guests` (the caller's CSV order); under `tfidf` the whole
 * result is a pure function of the inputs, and under `gateway` of the inputs plus the cache — two
 * runs produce byte-identical output either way.
 *
 * Whatever the provider, the assembled vector set passes {@link assertUsableVectors} BEFORE any
 * matrix math: cached vectors get exactly the same scrutiny as fresh ones.
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
  const targetable = guests.map((g) => isSeekTarget(g, conv.get(g.personId)));
  const seekers: EmbedDoc[] = [];
  for (let i = 0; i < guests.length; i++) {
    if (outbound[i]) seekers.push({ personId: guests[i].personId, text: seekDoc(guests[i]) });
  }
  log(
    `matches: ${guests.length} guest(s) · ${seekers.length} outbound seeker(s) · ` +
      `${guests.length - seekers.length} inbound-only (openSeeker / blank seeking)`,
  );
  const untargetable = guests.filter((_, i) => !targetable[i]);
  if (untargetable.length) {
    // Named, never silent (law b): removing someone from the room's demand side is a decision.
    log(
      `matches: ${untargetable.length} guest(s) outbound-only — their offer doc is the ` +
        `"${OFFER_FALLBACK}" fallback, which is our word and not theirs, so nobody is pointed at ` +
        `them: ${untargetable.map((g) => g.personId).join(", ")}`,
    );
  }

  const provider = opts.provider ?? vectorProvider();
  const docs = [...offers, ...seekers];
  let vectors: number[][];

  if (provider === "tfidf") {
    vectors = tfidfVectors(docs.map((d) => d.text));
    const vocab = vectors[0]?.length ?? 0;
    const empty = vectors.filter((v) => v.every((x) => x === 0)).length;
    log(
      `vectors: tfidf over ${docs.length} document(s) · ${vocab}-term vocabulary · no gateway, no cache` +
        (empty ? ` · ${empty} document(s) tokenized to nothing` : ""),
    );
    // vocabulary size is a corpus property, and an all-stopword doc is legitimately zero here
    assertUsableVectors(vectors, "tfidf-v1", { minDim: 1, allowZero: true });
  } else {
    const got = await embedWithCache(docs, { cacheOnly: opts.cacheOnly, path: opts.embedPath, log });
    vectors = got.vectors;
    log(`embed: ${got.hits} cache hit(s), ${got.embedded} newly embedded`);
    // The FULL set, cached entries included — DRY_RUN reads nothing but the cache.
    assertUsableVectors(vectors);
  }

  const offerVecs = vectors.slice(0, offers.length);
  const seekVecList = vectors.slice(offers.length);
  const seekVecs: Array<number[] | null> = [];
  let s = 0;
  let muted = 0;
  for (let i = 0; i < guests.length; i++) {
    if (!outbound[i]) {
      seekVecs.push(null);
      continue;
    }
    const v = seekVecList[s++];
    // A seek doc with no usable tokens (tfidf) cannot rank anyone: it would hand out five edges by
    // tie-break alone. That is an invented match, so they become inbound-only — named, not hidden.
    if (v.every((x) => x === 0)) {
      muted++;
      seekVecs.push(null);
    } else {
      seekVecs.push(v);
    }
  }
  if (muted) {
    log(`matches: ${muted} seeker(s) muted — their seeking answer has no usable tokens (inbound-only)`);
  }

  opts.onVectors?.({ ids, seekVecs, offerVecs, targetable });

  const seeks = buildSeekEdges(ids, seekVecs, offerVecs, targetable, (to) => viaFor(to, conv), {
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
