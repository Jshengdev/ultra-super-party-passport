/**
 * lib/places.ts — hometown → metro, and a vendored coordinate table for the metros.
 *
 * WHY THIS EXISTS. 312 guests wrote 213 distinct hometown strings, and 57 of them are Los
 * Angeles wearing ten spellings ("Los Angeles" · "LA" · "Los Angeles, CA" · "LOS ANGELES" ·
 * "los angeles" · "Los Ángeles" · …). Every count that keys on the raw cell therefore
 * UNDERCOUNTS: the biggest cohort in the room reads as 42, four smaller clusters of the same
 * city sit beside it, and a rarity ladder that ranks by cohort size is ranking spelling.
 * This module is the one place that decides two cells name the same place.
 *
 * EMIT-SIDE ONLY. `scripts/ingest-guests.ts` has its own `place()` that names the Neo4j
 * :Place nodes by leading locality; it is NOT touched here and must not be — changing it
 * would force a re-ingest of the whole population. This normalization runs at bake time over
 * the CSV cell, and the node keeps carrying the guest's verbatim `hometown` beside the
 * derived `metro`, so the receipt for every metro claim ships next to the claim (law c).
 *
 * WHAT MAY BE FOLDED, AND WHAT MAY NOT — the whole honesty of the feature is this line:
 *
 *   ALLOWED   the cell NAMES the metro, in another case, another script, an abbreviation
 *             everyone in this room reads the same way ("LA", "NYC", "SF", "SLO"), with a
 *             state or country suffix, or alongside other text ("LA/Beijing" leads with LA).
 *             Pure string aliasing: confidence 1.0, and the receipt is the verbatim cell.
 *   FORBIDDEN absorbing a nearby place into a metro it does not name. Santa Monica, Burbank,
 *             Torrance, Long Beach, Encino and Palos Verdes are all inside the Los Angeles
 *             metro area and all stay their own place here, because a guest who wrote
 *             "Encino" did not write "Los Angeles" and we do not get to say they did. An
 *             unmapped cell passes through as its LEADING LOCALITY, title-cased at most —
 *             never widened, never guessed into a metro.
 *
 * COORDINATES ARE WORLD KNOWLEDGE, NOT GUEST DATA. {@link METRO_COORDS} is vendored — city
 * positions, sourced from the city, stamped `vendored:city-table` wherever they are emitted
 * (law d). Its NAMES were seeded from the 50 pins the pepl build geocoded for this same
 * party; its NUMBERS were not, because those pins are per-cluster AVERAGES and about a third
 * of them landed outside the city they name (Cupertino at the centroid of California,
 * Philadelphia in New Jersey, Baltimore in Pennsylvania, Chicago 40km up the lake). A metro
 * this table has no entry for gets NO coordinates — it still ships in `places` with its real
 * count, and a map simply cannot draw it. An honest absence beats an invented dot.
 */

/** Stamped wherever the coordinate table's output is emitted — see the header (law d). */
export const PLACE_COORDS_SRC = "vendored:city-table";

/* ─────────────────────────── normalization primitives ─────────────────────────── */

/**
 * Casefold + strip diacritics + collapse whitespace + drop trailing punctuation. The KEY
 * space of both alias tables, and nothing else: it is never what gets emitted, so folding
 * "Los Ángeles" here costs no accent that a reader would see.
 */
export function normalizePlace(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\p{L}\p{N})]+$/gu, "");
}

/**
 * The trailing region tokens a no-comma cell may carry ("Irvine CA", "Perth Amboy New
 * Jersey", "Mumbai India"). A comma'd cell never needs this — the leading locality already
 * stops at the comma. Two-letter US abbreviations are included; the risk that a real place
 * name ENDS in one is why the strip only ever runs on the last of ≥2 tokens, and why every
 * one of the 213 cells in the export was inspected against it.
 */
const REGION_SUFFIX = new Set(
  (
    "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii " +
    "idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan " +
    "minnesota mississippi missouri montana nebraska nevada ohio oklahoma oregon pennsylvania " +
    "tennessee texas utah vermont virginia washington wisconsin wyoming " +
    "al ak az ar ca co ct de fl ga hi id il ia ks ky me md ma mi mn ms mo mt ne nv oh ok pa tn tx " +
    "ut vt va wa wi wy nj ny nc nd nh nm ri sc sd wv dc " +
    // the multi-word states + the one country that appears without a comma in this export
    "india"
  ).split(" "),
);
const REGION_SUFFIX_2 = ["new jersey", "new york", "north carolina", "north dakota", "new hampshire", "new mexico", "rhode island", "south carolina", "south dakota", "west virginia"];

/**
 * The leading locality: everything before the first separator, with a trailing region token
 * dropped. "Riverside, CA / Las Vegas, NV" → "Riverside"; "Thousand Oaks & Burbank" →
 * "Thousand Oaks"; "Hanoi, Vietnam (Rochester, NY)" → "Hanoi". The same first-place-wins
 * convention `scripts/ingest-guests.ts` names :Place nodes by, so the two never disagree
 * about WHICH place a compound cell is about — only about how it is spelled.
 */
export function leadingLocality(raw: string): string {
  let head = raw.split(/[/,(&]| and /i)[0].replace(/\s+/g, " ").trim();
  head = head.replace(/[^\p{L}\p{N})]+$/gu, "");
  const low = normalizePlace(head);
  for (const r of REGION_SUFFIX_2) {
    if (low.endsWith(` ${r}`) && low.length > r.length + 1) return head.slice(0, head.length - r.length).replace(/[\s,]+$/, "");
  }
  const toks = head.split(" ");
  if (toks.length > 1 && REGION_SUFFIX.has(normalizePlace(toks[toks.length - 1]))) {
    return toks.slice(0, -1).join(" ").replace(/[\s,]+$/, "");
  }
  return head;
}

/**
 * Title-case AT MOST, and only where casing carries no information: a head that is entirely
 * upper or entirely lower is a typing style ("LOS ANGELES", "dallas"), so it is cased; a head
 * that is already mixed is the guest's own spelling and is left alone ("Garden grove" stays
 * "Garden grove" — it merges with nothing, and rewriting it would be us editing their answer).
 * An all-caps token of ≤4 letters is an abbreviation we refuse to mangle into "Md"; if it is
 * an abbreviation this room reads the same way, it is in {@link LOCALITY_ALIAS} instead.
 */
function caseAtMost(head: string): string {
  if (head === "") return head;
  const upper = head === head.toUpperCase();
  const lower = head === head.toLowerCase();
  if (!upper && !lower) return head;
  if (upper && head.replace(/[^\p{L}]/gu, "").length <= 4) return head;
  return head
    .split(" ")
    .map((t) => (t.length === 0 ? t : t[0].toUpperCase() + t.slice(1).toLowerCase()))
    .join(" ");
}

/* ────────────────────────────── the two alias tables ────────────────────────────── */

/**
 * Keyed on the WHOLE normalized cell. Four entries, and every one of them is a cell whose
 * leading locality is not what the guest is telling us:
 *   · two cells that name Los Angeles somewhere other than the front — one leads with a
 *     neighbourhood before naming the city, one leads with the word "Atm";
 *   · two Lincolns. Dropping the state would merge Lincoln, California with Lincoln,
 *     Nebraska into a cohort of 2 that never existed — so where the state is what
 *     distinguishes two real places, the state stays in the name;
 *   · one cell whose region word IS the place ("South florida" — the suffix strip would
 *     leave the bare word "South").
 */
const CELL_ALIAS: Record<string, string> = {
  "eagle rock/nela/ los angeles": "Los Angeles",
  "atm los angeles, for at least a year more. grew up in sweden": "Los Angeles",
  "lincoln ca": "Lincoln, CA",
  "lincoln, nebraska": "Lincoln, NE",
  "south florida": "South Florida",
};

/**
 * Keyed on the normalized LEADING LOCALITY. Every entry is a different spelling of the same
 * name — case, diacritic, or an abbreviation this room reads one way — never a different
 * place folded into a bigger one. (Case-only variants that {@link caseAtMost} already merges,
 * like "dallas" or "san francisco", are deliberately absent: a table entry that changes
 * nothing is a table entry nobody can audit.)
 */
const LOCALITY_ALIAS: Record<string, string> = {
  la: "Los Angeles",
  "los angeles": "Los Angeles", // folds "Los Ángeles" and "LOS ANGELES" onto one name
  nyc: "New York",
  "new york city": "New York",
  sf: "San Francisco",
  slo: "San Luis Obispo",
};

/** What a hometown cell resolved to, and how. */
export interface Metro {
  /** the emitted place name */
  name: string;
  /** `alias` = a table entry decided it; `locality` = it passed through as its own leading locality */
  kind: "alias" | "locality";
}

/**
 * The one function that decides two hometown cells name the same place. Deterministic, offline,
 * no model, no fuzzy match: a cell either hits an enumerated alias or passes through as itself.
 * `null` for a blank or punctuation-only cell — a place with no name is not a place.
 */
export function metroOf(hometown: string | null | undefined): Metro | null {
  const raw = (hometown ?? "").trim();
  if (raw === "") return null;

  const cell = CELL_ALIAS[normalizePlace(raw)];
  if (cell) return { name: cell, kind: "alias" };

  const head = leadingLocality(raw);
  if (head.trim() === "") return null;

  const alias = LOCALITY_ALIAS[normalizePlace(head)];
  if (alias) return { name: alias, kind: "alias" };

  const cased = caseAtMost(head);
  return { name: cased, kind: cased === head ? "locality" : "alias" };
}

/* ───────────────────────────── the vendored coordinates ───────────────────────────── */

export interface Coord {
  lat: number;
  lng: number;
}

/**
 * `vendored:city-table` — world knowledge, keyed by the metro names {@link metroOf} produces.
 * Names seeded from the 50 pins the pepl build geocoded for this party; numbers taken from the
 * cities themselves (see the header for why the pins' own numbers were not reused). Two decimal
 * places is ~1km, which is all a room-scale map can use.
 *
 * A country or a US state is a legitimate answer to "Hometown?" and 14 guests gave one. Those
 * entries sit in their own block below and carry the region's centroid — a coarse pin, honestly
 * coarse, and never upgraded into a city the guest did not name.
 */
export const METRO_COORDS: Record<string, Coord> = {
  /* Los Angeles + the separate cities around it that guests named in their own right */
  "Los Angeles": { lat: 34.05, lng: -118.24 },
  Burbank: { lat: 34.18, lng: -118.31 },
  Encino: { lat: 34.16, lng: -118.5 },
  "Long Beach": { lat: 33.77, lng: -118.19 },
  "Palos Verdes": { lat: 33.77, lng: -118.39 },
  "Santa Clarita": { lat: 34.39, lng: -118.54 },
  "Santa Monica": { lat: 34.02, lng: -118.49 },
  "Thousand Oaks": { lat: 34.17, lng: -118.84 },
  Torrance: { lat: 33.84, lng: -118.34 },
  Ventura: { lat: 34.27, lng: -119.29 },

  /* the rest of California */
  Berkeley: { lat: 37.87, lng: -122.27 },
  Cupertino: { lat: 37.32, lng: -122.03 },
  Irvine: { lat: 33.68, lng: -117.83 },
  Oakland: { lat: 37.8, lng: -122.27 },
  "Orange County": { lat: 33.7, lng: -117.76 },
  "Palo Alto": { lat: 37.44, lng: -122.14 },
  Sacramento: { lat: 38.58, lng: -121.49 },
  "San Diego": { lat: 32.72, lng: -117.16 },
  "San Francisco": { lat: 37.77, lng: -122.42 },
  "San Luis Obispo": { lat: 35.28, lng: -120.66 },
  "Santa Clara": { lat: 37.35, lng: -121.96 },
  "Santa Cruz": { lat: 36.97, lng: -122.03 },

  /* the rest of the United States */
  Atlanta: { lat: 33.75, lng: -84.39 },
  Austin: { lat: 30.27, lng: -97.74 },
  Baltimore: { lat: 39.29, lng: -76.61 },
  Boston: { lat: 42.36, lng: -71.06 },
  Champaign: { lat: 40.12, lng: -88.24 },
  Chandler: { lat: 33.31, lng: -111.84 },
  Charlotte: { lat: 35.23, lng: -80.84 },
  Chicago: { lat: 41.88, lng: -87.63 },
  Cleveland: { lat: 41.5, lng: -81.69 },
  Dallas: { lat: 32.78, lng: -96.8 },
  Denver: { lat: 39.74, lng: -104.99 },
  Detroit: { lat: 42.33, lng: -83.05 },
  "Fort Wayne": { lat: 41.08, lng: -85.14 },
  "Fort Worth": { lat: 32.76, lng: -97.33 },
  Houston: { lat: 29.76, lng: -95.37 },
  "Las Vegas": { lat: 36.17, lng: -115.14 },
  Miami: { lat: 25.76, lng: -80.19 },
  Nashville: { lat: 36.16, lng: -86.78 },
  "New York": { lat: 40.71, lng: -74.01 },
  Orlando: { lat: 28.54, lng: -81.38 },
  Pahoa: { lat: 19.5, lng: -154.95 },
  Philadelphia: { lat: 39.95, lng: -75.17 },
  Phoenix: { lat: 33.45, lng: -112.07 },
  Portland: { lat: 45.52, lng: -122.68 },
  Raleigh: { lat: 35.78, lng: -78.64 },
  Richmond: { lat: 37.54, lng: -77.44 },
  "Rocky Mount": { lat: 37.0, lng: -79.89 },
  "Salt Lake City": { lat: 40.76, lng: -111.89 },
  "San Antonio": { lat: 29.42, lng: -98.49 },
  Seattle: { lat: 47.61, lng: -122.33 },
  "St. Charles": { lat: 41.91, lng: -88.31 },
  "St. Louis": { lat: 38.63, lng: -90.2 },
  Tampa: { lat: 27.95, lng: -82.46 },
  Winona: { lat: 44.05, lng: -91.64 },
  Wylie: { lat: 33.02, lng: -96.54 },

  /* the rest of the world */
  Auckland: { lat: -36.85, lng: 174.76 },
  Bangalore: { lat: 12.97, lng: 77.59 },
  Beijing: { lat: 39.9, lng: 116.41 },
  Hanoi: { lat: 21.03, lng: 105.85 },
  Jakarta: { lat: -6.21, lng: 106.85 },
  Liverpool: { lat: 53.41, lng: -2.98 },
  Moscow: { lat: 55.76, lng: 37.62 },
  Mumbai: { lat: 19.08, lng: 72.88 },
  "New Delhi": { lat: 28.61, lng: 77.21 },
  Paris: { lat: 48.86, lng: 2.35 },
  Prague: { lat: 50.08, lng: 14.44 },
  Rome: { lat: 41.9, lng: 12.5 },
  "Santo Domingo": { lat: 18.49, lng: -69.93 },
  Seoul: { lat: 37.57, lng: 126.98 },
  Shanghai: { lat: 31.23, lng: 121.47 },
  Singapore: { lat: 1.35, lng: 103.82 },
  Surabaya: { lat: -7.25, lng: 112.75 },
  Tokyo: { lat: 35.68, lng: 139.69 },
  Toronto: { lat: 43.65, lng: -79.38 },
  Vancouver: { lat: 49.28, lng: -123.12 },

  /* countries and US states — a coarse pin for a coarse answer, never upgraded to a city */
  Brazil: { lat: -14.24, lng: -51.93 },
  China: { lat: 35.86, lng: 104.2 },
  Florida: { lat: 27.66, lng: -81.52 },
  Louisiana: { lat: 30.98, lng: -91.96 },
  Mexico: { lat: 23.63, lng: -102.55 },
  Ohio: { lat: 40.42, lng: -82.91 },
  Philippines: { lat: 12.88, lng: 121.77 },
  "Sri Lanka": { lat: 7.87, lng: 80.77 },
  Taiwan: { lat: 23.7, lng: 121.0 },
  Venezuela: { lat: 6.42, lng: -66.59 },
  Vermont: { lat: 44.56, lng: -72.58 },
  Vietnam: { lat: 14.06, lng: 108.28 },
};

/** The vendored coordinate for a metro, or `undefined` — an honest absence, never a guess. */
export function coordOf(metro: string): Coord | undefined {
  return METRO_COORDS[metro];
}
