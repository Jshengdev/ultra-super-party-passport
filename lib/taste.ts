/**
 * lib/taste.ts — two answers everybody gave and nothing ever read.
 *
 * `Favorite movie/show?` and `Who is your biggest inspiration?` ship verbatim in all 312
 * records and are matched NOWHERE: no edge, no highlight, no count. Two people who both wrote
 * "Everything Everywhere All at Once" walk past each other. This module finds them.
 *
 * DETERMINISTIC, AND DELIBERATELY DUMB. No embeddings, no model call, no fuzzy match, no
 * synonym list: a match is EXACT equality of two canonicalized cells, so every twin can be
 * re-derived from the raw CSV by anyone holding this file (that is what
 * `scripts/audit-graph.ts` does, with its own copy of these rules). The cost is real and
 * accepted — "GOT" does not meet "Game of Thrones", and it should not, because the only way
 * to join them is a judgement no receipt can carry.
 *
 * THE WHOLE CELL IS THE UNIT. A cell naming three titles is not split into three titles:
 * splitting free text is a parse, a parse is a guess, and the guess would put words in a
 * guest's mouth ("Crazy, Stupid, Love" is not three films). The whole cell matches or nothing
 * does — which also makes the receipt exact on both sides: each twin ships the OTHER person's
 * cell byte-for-byte, and it is a byte-for-byte substring of that person's own `answers`.
 *
 * WHAT MAY NEVER MATCH — {@link PLACEHOLDER}. "My mom" is the single most common answer to the
 * inspiration question (7 people), and those are seven different women. A cell that names
 * someone by their relationship to the writer, or that declines the question ("n/a", "x"),
 * refers to a DIFFERENT referent for every writer, so equal strings there are not a shared
 * anything. Matching them would manufacture the most embarrassing false claim in the room.
 * They are excluded, counted, and reported — never silently dropped.
 */

/** The two answer fields a taste match may be drawn from. Keys of the emitted `taste` block. */
export const TASTE_FIELDS = ["favorite", "inspiration"] as const;
export type TasteField = (typeof TASTE_FIELDS)[number];

/**
 * Casefold, fold diacritics, normalize curly quotes, collapse whitespace, and strip wrapping
 * quotes/brackets plus terminal punctuation. Nothing else — no article stripping ("The Office"
 * and "Office" stay two different answers), no word reordering, no stemming.
 */
export function canonTaste(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'([\s]+/, "")
    .replace(/["'.,!?:;)\]\s]+$/, "")
    .trim();
}

/**
 * Canonical cells that can never be a match, whatever two guests share. Two classes, one
 * reason: the string is not the referent.
 *   · relational — "my mom", "my mentor", "my dad": a different person for every writer.
 *   · declined — "n/a", "x", "none": not an answer at all.
 * Closed and enumerated. Anything outside it is taken at face value, which is the point: we
 * do not get to decide that someone's real answer was not real.
 */
export const PLACEHOLDER: ReadonlySet<string> = new Set([
  // relational — the referent differs per writer
  "my mom", "my mother", "my mum", "my mama", "my momma", "mom", "mother",
  "my dad", "my father", "my papa", "dad", "father",
  "my parents", "my parent", "both my parents", "my mom and dad", "my mom & dad", "parents",
  "my family", "family", "my grandparents",
  "my grandma", "my grandmother", "my grandpa", "my grandfather", "grandma", "grandpa",
  "my sister", "my brother", "my aunt", "my uncle", "my cousin", "my siblings",
  "my wife", "my husband", "my partner", "my son", "my daughter", "my kids",
  "my mentor", "my manager", "my boss", "my professor", "my teacher", "my coach",
  "my friends", "my friend", "my best friend", "my peers", "my colleagues", "my co-workers",
  "myself", "me", "my self", "i am", "my past self", "my younger self",
  // declined — not an answer
  "n/a", "na", "none", "no one", "nobody", "x", "xx", "-", "--", "?", "??", "idk",
  "i don't know", "i dont know", "not sure", "too many", "too many to name", "tbd", ".",
]);

/** One side of a twin: who, and the byte-literal cell they wrote. */
export interface TasteTwin {
  personId: string;
  quote: string;
}
/** One field's finding for one person: their own verbatim cell + everyone who wrote the same. */
export interface TasteMatch {
  /** the guest's OWN cell, byte-for-byte — their half of the receipt */
  verbatim: string;
  /** the others, each carrying THEIR cell byte-for-byte — the other half */
  with: TasteTwin[];
}

export interface TasteInput {
  personId: string;
  answers: Record<string, string>;
}

/** A per-field tally the caller reports out loud — a filter nobody can see is a filter nobody can argue with. */
export interface TasteStats {
  /** distinct canonical cells shared by ≥2 people */
  clusters: number;
  /** people who ended up with ≥1 twin */
  people: number;
  /** people whose cell was excluded as a placeholder */
  placeheld: number;
  /** people who answered but matched nobody */
  unique: number;
  /** the largest cluster's size */
  biggest: number;
}

/**
 * Group a population by exact canonical equality, per field. Returns, per personId, only the
 * fields where they actually have a twin — a field with nobody on the other side is OMITTED,
 * never emitted empty (nothing zero renders).
 *
 * `with` is ordered by personId so a re-run of the same population produces the same bytes.
 */
export function tasteMatches(
  people: readonly TasteInput[],
): { matches: Map<string, Partial<Record<TasteField, TasteMatch>>>; stats: Record<TasteField, TasteStats> } {
  const matches = new Map<string, Partial<Record<TasteField, TasteMatch>>>();
  const stats = {} as Record<TasteField, TasteStats>;

  for (const field of TASTE_FIELDS) {
    const groups = new Map<string, TasteTwin[]>();
    let placeheld = 0;
    let answered = 0;
    for (const p of people) {
      const raw = (p.answers[field] ?? "").trim();
      if (raw === "") continue;
      answered += 1;
      const key = canonTaste(raw);
      if (key === "" || PLACEHOLDER.has(key)) {
        placeheld += 1;
        continue;
      }
      const arr = groups.get(key);
      if (arr) arr.push({ personId: p.personId, quote: raw });
      else groups.set(key, [{ personId: p.personId, quote: raw }]);
    }

    let clusters = 0;
    let matched = 0;
    let biggest = 0;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      clusters += 1;
      biggest = Math.max(biggest, members.length);
      members.sort((a, b) => a.personId.localeCompare(b.personId));
      for (const me of members) {
        matched += 1;
        const mine = matches.get(me.personId) ?? {};
        mine[field] = { verbatim: me.quote, with: members.filter((o) => o.personId !== me.personId) };
        matches.set(me.personId, mine);
      }
    }
    stats[field] = { clusters, people: matched, placeheld, unique: answered - placeheld - matched, biggest };
  }

  return { matches, stats };
}
