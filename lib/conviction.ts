/**
 * lib/conviction.ts — the conviction pass.
 *
 * Each guest wrote four free-text answers on the signup form. This distills them into a
 * CLOSED-VOCABULARY conviction: why they came to the industry (motive), the change they
 * want to make (mission), the effect they want on an audience (impact), and the craft
 * they're chasing (aspiration) — plus verbatim `quotes` that are the RECEIPTS for those
 * tags, and `openSeeker` (they're looking for "anyone", so they get no outbound match).
 *
 * THE LAWS this file obeys:
 *   (b) every LLM call is wrapped by a deterministic guard. Two of them here:
 *       1. SHAPE guard — `chat(..., BatchSchema)` (zod). The four vocabularies are
 *          `z.enum`s, so an off-vocabulary tag is unrepresentable: the model cannot
 *          invent a motive. Grounding-by-construction, same trick as the ontology gate.
 *       2. POST guard — `verifyQuotes()`. Every returned quote must be locatable as a
 *          whitespace-normalized VERBATIM substring of the answer field it is keyed to,
 *          and short. A quote the guest never wrote is a fabricated receipt. What gets
 *          STORED is the matched span sliced back out of the guest's own answer (snap to
 *          source), so a receipt is a literal substring of the CSV by construction.
 *       Violating guests get ONE retry (only the offenders are re-asked), then they get an
 *       all-null conviction carrying the `conviction-guard-failed` flag — visible on the
 *       Guest AND in the written artifact. Never a silent fallback.
 *   (c) claims carry receipts — `quotes` is the receipt for every non-null tag.
 *
 * DEGRADED: `GatewayNotConfigured` propagates untouched (it is not a guard failure —
 * it means "no creds", and the caller must exit 2, not write 312 empty records).
 *
 * Shared surface for downstream tasks: `Conviction`, `extractConvictions`, `verifyQuotes`,
 * `openSeekerBackstop`, `CONVICTIONS_PATH`, `GUARD_FAILED_FLAG`.
 */

import { z } from "zod";
import { chat, DEFAULT_CHAT_MODEL, GatewayNotConfigured, type ChatMessage } from "./gateway";
import type { Guest } from "./guests";

// ---------------------------------------------------------------------------
// Closed vocabularies (pinned by the task-4 brief — do NOT extend without the brief).
// ---------------------------------------------------------------------------

export const MOTIVES = [
  "family-industry", "childhood-immersion", "escape", "fandom-turned-maker",
  "representation-gap", "craft-obsession", "music-first", "games-first",
  "community-belonging", "storytelling-urge", "performance-joy", "accident-pivot",
] as const;

export const MISSIONS = [
  "representation-feel-seen", "joy-positivity", "preserve-stories", "build-community",
  "elevate-underdogs", "truth-inform", "wonder-escape", "craft-excellence",
  "prove-its-possible", "inspire-next-gen", "champion-artists",
] as const;

export const IMPACTS = [
  "make-people-feel-seen", "bring-joy", "create-escape-wonder", "connect-people",
  "provoke-thought", "keep-stories-alive", "inspire-action", "inform-truth", "comfort-heal",
] as const;

export const ASPIRATIONS = [
  "direct", "produce", "write", "edit", "act", "compose-music", "design",
  "represent-agency", "market-brand", "journalism", "games", "executive-pm",
  "photography", "casting", "cinematography", "entertainment-law", "undecided",
] as const;

export type Motive = (typeof MOTIVES)[number];
export type Mission = (typeof MISSIONS)[number];
export type Impact = (typeof IMPACTS)[number];
export type Aspiration = (typeof ASPIRATIONS)[number];

/** The answer fields we show the model — therefore the ONLY fields a quote may cite. */
export const QUOTE_FIELDS = ["goal", "drew", "seeking", "inspiration"] as const;
export type QuoteField = (typeof QUOTE_FIELDS)[number];

/** Flag stamped on `Guest.flags` (and on the written record) when the post-guard fails twice. */
export const GUARD_FAILED_FLAG = "conviction-guard-failed";

/** Where the script caches the pass so downstream tasks don't re-spend gateway calls. */
export const CONVICTIONS_PATH = "data/graph-private/convictions.json";

/** Batch size — the house pattern (`scripts/extract-interests.ts`). */
export const BATCH = 20;

/**
 * The chat model for this pass. `CONVICTION_MODEL` overrides `DEFAULT_CHAT_MODEL` so the model
 * can be bumped from the command line without a code change. Read at CALL time, not import time.
 */
export function convictionModel(): string {
  return process.env.CONVICTION_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}

/**
 * A receipt longer than this isn't a quote, it's the whole answer.
 *
 * CALIBRATED CONSTANT (golden run 2026-07-25): started at the brief's 15 and the live golden
 * threw away 4/10 guests on this cap alone — gpt-4o-mini returns 17-40-word spans and the retry
 * made them longer, not shorter. Raised to 25 as the hard backstop; the PROMPT still asks for
 * <=12 words, so the cap only catches the model overshooting its instruction, not obeying it.
 * The verbatim-substring check is untouched — that one never bends.
 */
export const MAX_QUOTE_WORDS = 25;

// ---------------------------------------------------------------------------
// Shapes.
// ---------------------------------------------------------------------------

export interface Conviction {
  motive: string | null;
  mission: string | null;
  impact: string | null;
  aspiration: string | null;
  /**
   * field name (goal|drew|seeking|inspiration) -> the span from that field, snapped to the
   * source bytes: a LITERAL substring of the guest's CSV answer, safe for exact matching.
   */
  quotes: Record<string, string>;
  openSeeker: boolean;
  /** Present ONLY when the post-guard failed twice — the failure must survive into the artifact. */
  flags?: string[];
}

const ItemSchema = z.object({
  personId: z.string(),
  motive: z.enum(MOTIVES).nullable(),
  mission: z.enum(MISSIONS).nullable(),
  impact: z.enum(IMPACTS).nullable(),
  aspiration: z.enum(ASPIRATIONS).nullable(),
  quotes: z.record(z.string()).default({}),
  openSeeker: z.boolean(),
});
export type ConvictionItem = z.infer<typeof ItemSchema>;

const BatchSchema = z.object({ items: z.array(ItemSchema) });

// ---------------------------------------------------------------------------
// Deterministic helpers (pure — unit-testable without a gateway).
// ---------------------------------------------------------------------------

const APOSTROPHES = /[‘’ʼ′]/;
const DOUBLE_QUOTES = /[“”″]/;
const DASHES = /[‐-―−]/;
const COMBINING = /\p{M}/u;

/**
 * One folded UTF-16 code unit + the [start, end) slice of the ORIGINAL string that produced it.
 * `start.length === end.length === folded.length` is an invariant, asserted where it is built.
 */
interface FoldMap {
  folded: string;
  start: number[];
  end: number[];
}

/** The index map broke its own invariant — a bug in `foldWithMap`, never a bad model output. */
export class FoldMapInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoldMapInvariantError";
  }
}

/** NFKC + typographic quote/dash fold for one grapheme-ish unit (base char + combining marks). */
function foldUnit(unit: string): string {
  let out = "";
  for (const c of unit.normalize("NFKC")) {
    if (APOSTROPHES.test(c)) out += "'";
    else if (DOUBLE_QUOTES.test(c)) out += '"';
    else if (DASHES.test(c)) out += "-";
    else out += c;
  }
  return out;
}

/**
 * The tolerant fold, WITH an index map back to the source.
 *
 * Fold rules (same three as always): collapse whitespace runs to one space and trim (the prompt
 * renders multi-line answers on one line, so a newline legitimately comes back as a space); fold
 * typographic quotes/dashes onto their ASCII twins (same characters, different code points —
 * models re-encode them); NFKC per grapheme cluster so a decomposed "e + ́" still matches a
 * precomposed "é". Case is NOT folded: verbatim means verbatim.
 *
 * The map is what makes SNAP-TO-SOURCE possible: `start[i]`/`end[i]` bracket the original
 * characters behind `folded[i]`, so a match located in folded space can be sliced back out of the
 * untouched source. The fold is for LOCATING only — it never reaches storage.
 */
function foldWithMap(s: string): FoldMap {
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;

  while (i < s.length) {
    const first = String.fromCodePoint(s.codePointAt(i)!);
    if (/\s/.test(first)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (out.length > 0) { out.push(" "); start.push(i); end.push(j); } // leading run dropped = trim
      i = j;
      continue;
    }
    let unit = first;
    let len = first.length;
    while (i + len < s.length) {
      const next = String.fromCodePoint(s.codePointAt(i + len)!);
      if (!COMBINING.test(next)) break;
      unit += next;
      len += next.length;
    }
    // ONE SLOT PER UTF-16 CODE UNIT — not per code point. `folded` is indexed by `String.indexOf`,
    // which counts UTF-16 units, so an astral char (emoji: 1 code point, 2 units) must occupy TWO
    // slots or every index after it is off by one per astral char, and the snap slices the wrong
    // span (silently — the wrong span is still *a* substring). Hence the char-by-char loop.
    const repl = foldUnit(unit);
    for (let k = 0; k < repl.length; k++) { out.push(repl[k]!); start.push(i); end.push(i + len); }
    i += len;
  }
  while (out.length && out[out.length - 1] === " ") { out.pop(); start.pop(); end.pop(); } // trailing trim

  const folded = out.join("");
  // Hard invariant: folded index space === map index space. If this ever trips, every snapped span
  // downstream is suspect, so fail loud rather than hand back a plausible-looking wrong receipt.
  if (folded.length !== start.length || start.length !== end.length) {
    throw new FoldMapInvariantError(
      `foldWithMap index map desync: folded=${folded.length} units, start=${start.length}, end=${end.length}`,
    );
  }
  return { folded, start, end };
}

/**
 * Normalize for VERBATIM comparison — the folded half of {@link foldWithMap}. Single definition,
 * so the guard's comparison and the snap's index map can never drift apart.
 */
export function normalizeForCompare(s: string): string {
  return foldWithMap(s).folded;
}

/**
 * Deterministic backstop for `openSeeker` — ORed with the model's answer so a generic
 * "anyone!" can never slip through as a real seek. Regex pinned by the brief.
 */
export function openSeekerBackstop(seeking: string): boolean {
  return /\b(anyone|everyone|everybody|all kinds|open to)\b/i.test(seeking);
}

/**
 * THE POST-GUARD, and the SNAP. Every quote the model returned must be:
 *   - keyed to one of the four answer fields it was actually shown (`QUOTE_FIELDS`),
 *   - non-empty,
 *   - <= MAX_QUOTE_WORDS words,
 *   - locatable as a verbatim substring of THAT field's text for THIS guest, under the tolerant
 *     fold (whitespace collapse + typographic quote/dash fold + NFKC).
 *
 * SNAP-TO-SOURCE: the fold is how we LOCATE a quote, never what we STORE. Once located, the
 * returned `snapped[field]` is sliced straight out of the guest's untouched answer, so it is a
 * literal substring of the CSV by construction — byte-for-byte, curly apostrophes and double
 * spaces included. Live golden 2026-07-25: the model handed back "i've" where TJ wrote "i’ve";
 * the tolerant fold correctly accepted it, but storing the model's spelling would have broken
 * every downstream consumer that does exact (whitespace-normalized-only) matching against the
 * CSV — receipt-highlight spans, the Task 7 audit. Callers MUST store `snapped`, not the raw
 * `item.quotes`.
 *
 * Pure + synchronous by design: the receipts audit and the golden assertions can re-run it
 * independently of the extraction that produced the item.
 *
 * @returns `{ ok, violations, snapped }` — `violations` is a human-readable list for the retry
 *          nudge; `snapped` holds every quote that passed, canonicalized to the source bytes.
 */
export function verifyQuotes(
  guest: Guest,
  item: { quotes?: Record<string, string> | null },
): { ok: boolean; violations: string[]; snapped: Record<string, string> } {
  const violations: string[] = [];
  const snapped: Record<string, string> = {};
  const quotes = item.quotes ?? {};

  for (const [field, quote] of Object.entries(quotes)) {
    if (!(QUOTE_FIELDS as readonly string[]).includes(field)) {
      violations.push(`unknown quote field "${field}" (allowed: ${QUOTE_FIELDS.join("|")})`);
      continue;
    }
    if (typeof quote !== "string" || quote.trim() === "") {
      violations.push(`empty quote for field "${field}"`);
      continue;
    }
    const q = normalizeForCompare(quote);
    if (q === "") {
      violations.push(`quote for "${field}" is empty after normalization: ${JSON.stringify(quote.slice(0, 80))}`);
      continue;
    }
    if (q.split(" ").length > MAX_QUOTE_WORDS) {
      violations.push(`quote for "${field}" is ${q.split(" ").length} words (max ${MAX_QUOTE_WORDS})`);
      continue;
    }
    const raw = guest.answers[field as QuoteField] ?? "";
    const src = foldWithMap(raw);
    const at = src.folded.indexOf(q);
    if (at < 0) {
      violations.push(`quote for "${field}" is NOT verbatim: ${JSON.stringify(quote.slice(0, 80))}`);
      continue;
    }
    // Map the folded match back onto the original characters and store THOSE.
    snapped[field] = raw.slice(src.start[at]!, src.end[at + q.length - 1]!);
  }

  return { ok: violations.length === 0, violations, snapped };
}

/** True when the guest wrote something in at least one of the four prompted fields. */
export function hasEvidence(guest: Guest): boolean {
  return QUOTE_FIELDS.some((f) => (guest.answers[f] ?? "").trim() !== "");
}

/** All-null conviction. `openSeeker` stays deterministic (regex, not a model claim). */
function nullConviction(guest: Guest, flags?: string[]): Conviction {
  return {
    motive: null, mission: null, impact: null, aspiration: null,
    quotes: {},
    openSeeker: openSeekerBackstop(guest.answers.seeking ?? ""),
    ...(flags?.length ? { flags } : {}),
  };
}

function markGuest(guest: Guest, flag: string): void {
  if (!guest.flags.includes(flag)) guest.flags.push(flag);
}

// ---------------------------------------------------------------------------
// The prompt.
// ---------------------------------------------------------------------------

/** Keep the rendered batch bounded; a quote from the visible prefix is still a substring. */
const ANSWER_CAP = 600;

function renderAnswer(v: string): string {
  const one = v.replace(/\s+/g, " ").trim();
  return one.length > ANSWER_CAP ? one.slice(0, ANSWER_CAP) : one || "(blank)";
}

function renderGuest(g: Guest): string {
  return [
    `personId: ${g.personId}`,
    `  title: ${g.title || "(blank)"}`,
    `  goal: ${renderAnswer(g.answers.goal)}`,
    `  drew: ${renderAnswer(g.answers.drew)}`,
    `  seeking: ${renderAnswer(g.answers.seeking)}`,
    `  inspiration: ${renderAnswer(g.answers.inspiration)}`,
  ].join("\n");
}

const SYSTEM = [
  "You read party guests' own signup answers and tag their convictions using CLOSED vocabularies.",
  "Return one item per listed personId. Use EXACTLY the personId strings given.",
  "",
  "motive (why they entered the industry — mostly from `drew`), one of:",
  MOTIVES.join(", "),
  "mission (the change they want their work to make), one of:",
  MISSIONS.join(", "),
  "impact (the effect they want on an audience), one of:",
  IMPACTS.join(", "),
  "aspiration (the craft/role they are pursuing — from `goal`, corroborated by `title`), one of:",
  ASPIRATIONS.join(", "),
  "",
  "RULES:",
  "1. DEPTH vs GUESSING — they are not the same thing.",
  "   `motive` is expected for MOST guests: the `drew` answer nearly always says why they came",
  "   (a parent in the business, a childhood spent inside movies, a fandom that turned into making,",
  "   never seeing themselves on screen, an obsession with the craft itself, a pivot they fell into).",
  "   Whenever `drew` says anything substantive, pick the closest motive tag. Reserve null for",
  "   genuinely blank, one-word, or evasive answers.",
  "   `mission` and `impact` stay CONSERVATIVE: tag them only when the guest actually names the",
  "   change they want to make or the effect they want on an audience. Never infer either from a",
  "   job title. null is the common, correct answer for these two.",
  "2. `quotes` maps an answer field name (goal | drew | seeking | inspiration) to a SHORT VERBATIM",
  "   FRAGMENT copied CHARACTER-FOR-CHARACTER out of that field for that guest. 12 WORDS MAX.",
  "   - Copy a contiguous fragment. NEVER quote a whole sentence, never the whole answer.",
  "   - NEVER add, remove, or change any punctuation or capitalization — not even a trailing period.",
  "     Do not wrap it in quotation marks. Begin and end mid-sentence if that is where the evidence is.",
  "   - Never paraphrase, never merge two fields, never quote a field you were not shown.",
  "   - If you cannot copy exactly, omit that quote. An edited or invented quote is rejected by a",
  "     verbatim substring check and the guest is thrown away.",
  "   WORKED EXAMPLE — given this field text:",
  "     drew: I grew up on my mom's set watching her cut trailers, and by the time I was twelve I",
  "     knew I wanted to be the one deciding what an audience feels.",
  '   GOOD (8 words): "grew up on my mom\'s set watching her"',
  '   BAD: "I grew up on my mom\'s set watching her cut trailers." (whole sentence + added period)',
  '   BAD: "She grew up watching her mom cut trailers" (paraphrase, re-capitalized)',
  "3. `aspiration` = the MOST SPECIFIC tag that `title` + `goal` LITERALLY name. Do not climb to a",
  "   broader tag when a precise one exists in the list: a Casting Director / casting associate ->",
  "   casting (NOT represent-agency, NOT produce); a cinematographer or DP -> cinematography (NOT",
  "   direct); an agent or manager signing clients at an agency -> represent-agency.",
  "4. `openSeeker` = true when the `seeking` answer is generic and undifferentiated (\"anyone\",",
  "   \"everyone\", \"all kinds of people\", \"open to anything\", \"like-minded people\") with no",
  "   specific role, craft, or industry noun. false when they name a kind of person.",
  // Deliberately generic examples: the golden acceptance cases are NOT spelled out here —
  // teaching to the test would make the assertion tautological.
  "5. When a guest names several crafts, tag the one they LEAD WITH (the one they state first /",
  '   build the sentence around): "a director who also edits" -> direct; "writer-turned-producer"',
  "   -> produce. Do not average two crafts into a third.",
  "",
  'Respond with ONLY this JSON object: {"items":[{"personId":"...","motive":null,"mission":null,',
  '"impact":null,"aspiration":null,"quotes":{"goal":"..."},"openSeeker":false}]}',
].join("\n");

async function askBatch(guests: Guest[], nudge: string | null): Promise<ConvictionItem[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        (nudge ? `${nudge}\n\n` : "") +
        `Guests (${guests.length}):\n\n${guests.map(renderGuest).join("\n\n")}`,
    },
  ];
  const out = await chat(convictionModel(), messages, BatchSchema);
  // `.default({})` fills `quotes` at parse time; the `?? {}` is the type-level twin of that
  // (zod's inferred INPUT type still marks a defaulted field optional).
  return out.items.map((it) => ({ ...it, quotes: it.quotes ?? {} }));
}

// ---------------------------------------------------------------------------
// extractConvictions — batched, guarded, fail-loud.
// ---------------------------------------------------------------------------

/**
 * Extract a Conviction for every guest, keyed by personId.
 *
 * Per batch of {@link BATCH}: ask → shape guard (zod, inside `chat`) → post guard
 * ({@link verifyQuotes}) → re-ask ONLY the guests that failed, once → whatever still
 * fails gets `nullConviction(guest, [GUARD_FAILED_FLAG])` and the same flag pushed onto
 * `guest.flags` (the Guest objects are mutated in place — that is how the failure reaches
 * the ingest/passport surfaces, which read `Guest.flags`).
 *
 * Guests with all four prompted answers blank never reach the gateway: they get an
 * all-null conviction with NO flag (absence of evidence is not a guard failure).
 *
 * @throws GatewayNotConfigured immediately, untouched — DEGRADED is not a guard failure.
 */
export async function extractConvictions(guests: Guest[]): Promise<Map<string, Conviction>> {
  const out = new Map<string, Conviction>();

  const askable: Guest[] = [];
  for (const g of guests) {
    if (hasEvidence(g)) askable.push(g);
    else out.set(g.personId, nullConviction(g)); // nothing to read — not a failure
  }
  const skipped = guests.length - askable.length;
  if (skipped) console.log(`conviction: ${skipped} guest(s) with no answers — all-null, not asked`);

  const batches = Math.ceil(askable.length / BATCH);
  for (let i = 0; i < askable.length; i += BATCH) {
    const batch = askable.slice(i, i + BATCH);
    const n = i / BATCH + 1;
    const byId = new Map(batch.map((g) => [g.personId, g]));
    const pending = new Map(byId);

    for (let attempt = 1; attempt <= 2 && pending.size > 0; attempt++) {
      const ask = [...pending.values()];
      const violationLines: string[] = [];
      let items: ConvictionItem[];
      try {
        items = await askBatch(
          ask,
          attempt === 1
            ? null
            : "Your previous answer was REJECTED by a verbatim-quote check for these guests. Redo them. " +
              "SHORTEN every quote to a contiguous fragment of 12 words or fewer, copied " +
              "character-for-character out of the named field — do not lengthen it, do not add a " +
              "trailing period, do not re-capitalize, do not paraphrase. If you cannot copy a fragment " +
              "exactly, return an empty quotes object {} for that guest: an omitted quote is fine, an " +
              "edited one throws the guest away. Keep the tags.",
        );
      } catch (err) {
        if (err instanceof GatewayNotConfigured) throw err; // DEGRADED — never swallow
        const msg = err instanceof Error ? `${err.name}: ${err.message.slice(0, 160)}` : String(err);
        console.error(`conviction batch ${n}/${batches} attempt ${attempt} FAILED — ${msg}`);
        continue;
      }

      for (const item of items) {
        const guest = pending.get(item.personId);
        if (!guest) {
          if (!byId.has(item.personId)) {
            console.error(`conviction batch ${n}: model returned unknown personId "${item.personId}" — dropped`);
          }
          continue;
        }
        const check = verifyQuotes(guest, item);
        if (!check.ok) {
          violationLines.push(`${guest.personId}: ${check.violations.join("; ")}`);
          continue; // stays pending
        }
        out.set(guest.personId, {
          motive: item.motive,
          mission: item.mission,
          impact: item.impact,
          aspiration: item.aspiration,
          // `check.snapped`, never `item.quotes` — stored receipts are source bytes, not the
          // model's re-spelling of them.
          quotes: check.snapped,
          openSeeker: item.openSeeker || openSeekerBackstop(guest.answers.seeking ?? ""),
        });
        pending.delete(guest.personId);
      }

      if (violationLines.length) {
        console.error(
          `conviction batch ${n} attempt ${attempt}: POST-GUARD rejected ${violationLines.length} item(s)\n  ` +
            violationLines.join("\n  "),
        );
      }
      if (pending.size && attempt === 1) {
        const missing = [...pending.keys()].filter((id) => !items.some((it) => it.personId === id));
        if (missing.length) console.error(`conviction batch ${n}: no item returned for ${missing.join(", ")}`);
      }
    }

    for (const guest of pending.values()) {
      markGuest(guest, GUARD_FAILED_FLAG);
      out.set(guest.personId, nullConviction(guest, [GUARD_FAILED_FLAG]));
    }

    const failed = pending.size;
    console.log(
      `conviction batch ${n}/${batches}: ${batch.length - failed}/${batch.length} extracted` +
        (failed ? ` · ${failed} ${GUARD_FAILED_FLAG}` : ""),
    );
  }

  return out;
}
