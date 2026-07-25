/**
 * app/graph/pepl/adapter.ts — OUR content, pepl's scene.
 *
 * This is the seam the pepl handoff names (§5): implement `GraphAdapter` over
 * your own data and the sheet, bubble, boards, choreography and Monet chain are
 * untouched. pepl's own adapter + `data/party.ts` are deliberately NOT ported —
 * they are its backend, and ours is richer: 312 guests with convictions, seek
 * matches and receipts, baked to `public/graph/*` by the v2 pipeline.
 *
 * Group = creative motive. That is what this room already colours by, and it is
 * the value-cloud the product is actually about — school buckets would be a
 * shallower cut of the same people.
 */

export type Person = { id: string; name: string; groupId: string; tags?: string[] };
export type Group = { id: string; name: string; weight: number };

export interface GraphAdapter {
  groups(): Group[];
  people(): Person[];
}

/** Details the stamps read. Mirrors pepl's GuestDetails so Stamps.tsx is untouched. */
export type GuestDetails = {
  school: string;
  company: string;
  title: string;
  hometown: string;
  instagram: string;
  movie: string;
};

/** Person↔person threads as the v2 emitter bakes them — same vocabulary as
    the old room: school / company / seek (who looks for whom) / why (nearest
    neighbours inside a shared conviction tag). */
export type RoomEdgeType = "school" | "company" | "seek" | "why";
export interface RoomEdge {
  s: string;
  t: string;
  type: RoomEdgeType;
  via?: string;
  /** seek only: the pull is mutual */
  m?: boolean;
}

/** The shape our emitter bakes into public/graph/graph.json. */
export interface RoomNode {
  id: string;
  name: string;
  title?: string;
  school?: string | null;
  company?: string | null;
  motive?: string | null;
  mission?: string | null;
  hometown?: string | null;
  instagram?: string | null;
  favorite?: string | null;
}

/** Group names ride an 18-column segment board — pepl caps them at 16 chars. */
const MAX_GROUP_NAME = 16;

function pretty(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function clampName(s: string): string {
  return s.length <= MAX_GROUP_NAME ? s : `${s.slice(0, MAX_GROUP_NAME - 1)}…`;
}

export class RoomAdapter implements GraphAdapter {
  private _groups: Group[] = [];
  private _people: Person[] = [];
  private _details: Record<string, Partial<GuestDetails>> = {};

  constructor(nodes: RoomNode[]) {
    /* 26 guests never answered the motive question. A cloud of "unplaced" is
     * both ugly and uninformative, so they are FOLDED into the room by their
     * aspiration — placed beside the people doing the same kind of work.
     *
     * This is a LAYOUT placement, not a claim: nothing renders "their motive is
     * X" for these people, because we do not know it. If a surface ever wants to
     * assert a motive, it must read `motive` itself and find it empty. */
    const motiveByAsp = new Map<string, Map<string, number>>();
    for (const n of nodes) {
      const m = (n.motive ?? "").trim();
      const a = (n.mission ?? "").trim();
      if (!m || !a) continue;
      const row = motiveByAsp.get(a) ?? new Map<string, number>();
      row.set(m, (row.get(m) ?? 0) + 1);
      motiveByAsp.set(a, row);
    }
    const commonest = (a: string): string | null => {
      const row = motiveByAsp.get(a);
      if (!row) return null;
      return [...row.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    };
    // the largest motive, used as the last resort so nobody is left stranded
    const tallyMotive = new Map<string, number>();
    for (const n of nodes) {
      const m = (n.motive ?? "").trim();
      if (m) tallyMotive.set(m, (tallyMotive.get(m) ?? 0) + 1);
    }
    const biggest = [...tallyMotive.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "the room";

    const byMotive = new Map<string, RoomNode[]>();
    for (const n of nodes) {
      const own = (n.motive ?? "").trim();
      const key = own || commonest((n.mission ?? "").trim()) || biggest;
      const list = byMotive.get(key);
      if (list) list.push(n);
      else byMotive.set(key, [n]);
    }

    const total = Math.max(1, nodes.length);
    // biggest cloud first, so the largest inscription lands nearest the centre
    const ordered = [...byMotive.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [key, members] of ordered) {
      const id = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unplaced";
      this._groups.push({
        id,
        name: clampName(pretty(key)),
        // weight drives cluster radius: share of the room, same as pepl
        weight: Math.max(0.35, (members.length / total) * 4),
      });
      for (const n of members) {
        this._people.push({ id: n.id, name: n.name, groupId: id });
        this._details[n.id] = {
          school: n.school ?? "",
          company: n.company ?? "",
          title: n.title ?? "",
          hometown: n.hometown ?? "",
          instagram: n.instagram ?? "",
          movie: n.favorite ?? "",
        };
      }
    }
  }

  groups(): Group[] {
    return this._groups;
  }
  people(): Person[] {
    return this._people;
  }
  details(): Record<string, Partial<GuestDetails>> {
    return this._details;
  }
}

/** Empty until the room JSON lands — the scene mounts, then re-seeds. */
export const emptyAdapter: GraphAdapter = new RoomAdapter([]);

/* ---------------------------------------------------------------------------
 * Derived tables the ported widgets read.
 *
 * pepl generates these into data/party.ts from its CSV. We derive them from the
 * baked room instead, so there is one source of content and no second guest
 * list to keep in sync.
 * ------------------------------------------------------------------------ */

export type TickerSchool = { name: string; n: number };
export type TickerCompany = { name: string; n: number; domain?: string; slug?: string };
export type SchoolCompanyPair = { school: string; company: string; n: number };
export type HometownPin = { name: string; lat: number; lng: number; n: number; people: string[] };

/** Company logos shipped in public/logos — the ticker only shows a mark it has. */
const LOGO_SLUGS = new Set<string>(["amc-networks","caa","capitol-records","disney","dreamworks","e-l-f-beauty","espn","focus-features","fox-entertainment","fremantle","lionsgate","live-nation","nbcuniversal","neon","netflix","nfl","obb-media","paramount","snap-inc","sony-music","sony-pictures","television-academy","tiktok","universal-music-group","uta","warner-bros-discovery"]);

function tally(values: (string | null | undefined)[]): { name: string; n: number }[] {
  const m = new Map<string, number>();
  for (const v of values) {
    const t = (v ?? "").trim();
    if (!t) continue;
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
}

/** Mutable scene tables — the route seeds these once the room JSON lands. */
export let defaultAdapter: GraphAdapter = new RoomAdapter([]);
export let ROOM_EDGES: RoomEdge[] = [];
export let GUEST_DETAILS: Record<string, Partial<GuestDetails>> = {};
export let TICKER_SCHOOLS: TickerSchool[] = [];
export let TICKER_COMPANIES: TickerCompany[] = [];
export let SCHOOL_COMPANY_PAIRS: SchoolCompanyPair[] = [];
/* Geocoded hometowns. Our pipeline bakes the hometown STRING but no coordinates,
   and a map is worthless without them — so this table comes across from the pepl
   build, which geocoded the same LA intern party guest list. Same people, same
   answers; only the lat/lng is borrowed. Regenerate here if the list changes. */
export const HOMETOWN_PINS: HometownPin[] = [
  {
    "name": "Philippines",
    "lat": 12.88,
    "lng": 121.77,
    "n": 1,
    "people": [
      "Tyler Bumgarner"
    ]
  },
  {
    "name": "Winona",
    "lat": 44.05,
    "lng": -91.64,
    "n": 1,
    "people": [
      "Nicole Spartz"
    ]
  },
  {
    "name": "Bangalore",
    "lat": 12.97,
    "lng": 77.59,
    "n": 1,
    "people": [
      "Pragya Bhatt"
    ]
  },
  {
    "name": "Pahoa",
    "lat": 19.49,
    "lng": -154.95,
    "n": 1,
    "people": [
      "Keona Edwards"
    ]
  },
  {
    "name": "Auckland",
    "lat": -36.85,
    "lng": 174.76,
    "n": 1,
    "people": [
      "Crystal Qianhui Xu"
    ]
  },
  {
    "name": "Champaign",
    "lat": 40.12,
    "lng": -88.24,
    "n": 1,
    "people": [
      "Dina Hashash"
    ]
  },
  {
    "name": "Mumbai",
    "lat": 19.08,
    "lng": 72.88,
    "n": 1,
    "people": [
      "Saamya Patel"
    ]
  },
  {
    "name": "Liverpool",
    "lat": 53.41,
    "lng": -2.98,
    "n": 1,
    "people": [
      "Ruby Washio"
    ]
  },
  {
    "name": "Mexico",
    "lat": 23.63,
    "lng": -102.55,
    "n": 1,
    "people": [
      "Ines Villarreal"
    ]
  },
  {
    "name": "Fort Wayne",
    "lat": 41.08,
    "lng": -85.14,
    "n": 1,
    "people": [
      "Anthony Gery"
    ]
  },
  {
    "name": "Jakarta",
    "lat": -6.21,
    "lng": 106.85,
    "n": 1,
    "people": [
      "Erin"
    ]
  },
  {
    "name": "Tokyo",
    "lat": 35.68,
    "lng": 139.69,
    "n": 1,
    "people": [
      "Taro Arthur"
    ]
  },
  {
    "name": "Singapore",
    "lat": 1.35,
    "lng": 103.82,
    "n": 1,
    "people": [
      "Laetitia"
    ]
  },
  {
    "name": "Rocky Mount",
    "lat": 37.43,
    "lng": -78.66,
    "n": 1,
    "people": [
      "Sebastian Ellis"
    ]
  },
  {
    "name": "Salt Lake City",
    "lat": 40.76,
    "lng": -111.89,
    "n": 1,
    "people": [
      "Brandon Grover"
    ]
  },
  {
    "name": "Vancouver",
    "lat": 49.28,
    "lng": -123.12,
    "n": 1,
    "people": [
      "Elysia"
    ]
  },
  {
    "name": "Chandler",
    "lat": 34.05,
    "lng": -111.09,
    "n": 1,
    "people": [
      "Shreena Garg"
    ]
  },
  {
    "name": "St. Louis",
    "lat": 38.63,
    "lng": -90.2,
    "n": 1,
    "people": [
      "Rachel Gray"
    ]
  },
  {
    "name": "Toronto",
    "lat": 43.65,
    "lng": -79.38,
    "n": 1,
    "people": [
      "W. Stewart Fenn"
    ]
  },
  {
    "name": "Seoul",
    "lat": 37.57,
    "lng": 126.98,
    "n": 1,
    "people": [
      "Garvin Kim"
    ]
  },
  {
    "name": "China",
    "lat": 35.86,
    "lng": 104.2,
    "n": 1,
    "people": [
      "Harrison Li"
    ]
  },
  {
    "name": "Las Vegas",
    "lat": 36.17,
    "lng": -115.14,
    "n": 1,
    "people": [
      "Judah Adkins"
    ]
  },
  {
    "name": "Nashville",
    "lat": 36.16,
    "lng": -86.78,
    "n": 1,
    "people": [
      "Kevin Rome"
    ]
  },
  {
    "name": "Surabaya",
    "lat": -0.79,
    "lng": 113.92,
    "n": 1,
    "people": [
      "Kelly Teguh"
    ]
  },
  {
    "name": "Detroit",
    "lat": 42.33,
    "lng": -83.05,
    "n": 1,
    "people": [
      "Brooklynne"
    ]
  },
  {
    "name": "Shanghai",
    "lat": 31.23,
    "lng": 121.47,
    "n": 1,
    "people": [
      "Emily Zhang"
    ]
  },
  {
    "name": "Taiwan",
    "lat": 23.7,
    "lng": 121,
    "n": 2,
    "people": [
      "YU-SHENG CHIEN",
      "Melody Wu"
    ]
  },
  {
    "name": "Beijing",
    "lat": 39.9,
    "lng": 116.4,
    "n": 2,
    "people": [
      "Kit He",
      "Capri Jia"
    ]
  },
  {
    "name": "St. Charles",
    "lat": 40.63,
    "lng": -89.4,
    "n": 2,
    "people": [
      "Kemp Connelly",
      "KShae"
    ]
  },
  {
    "name": "Portland",
    "lat": 45.52,
    "lng": -122.68,
    "n": 2,
    "people": [
      "Sarah Lee",
      "Victor Smith"
    ]
  },
  {
    "name": "Dallas",
    "lat": 32.78,
    "lng": -96.8,
    "n": 2,
    "people": [
      "Evangelina Yang",
      "Sanjna Kolli"
    ]
  },
  {
    "name": "Seattle",
    "lat": 47.61,
    "lng": -122.33,
    "n": 2,
    "people": [
      "Berkley Robins",
      "Sophia Chew"
    ]
  },
  {
    "name": "Boston",
    "lat": 42.36,
    "lng": -71.06,
    "n": 2,
    "people": [
      "Diego",
      "Courtney Hannon"
    ]
  },
  {
    "name": "Ohio",
    "lat": 40.42,
    "lng": -82.91,
    "n": 2,
    "people": [
      "Aure Minor",
      "Nora Levy"
    ]
  },
  {
    "name": "Denver",
    "lat": 39.74,
    "lng": -104.99,
    "n": 3,
    "people": [
      "Jonah Einisman",
      "Tiggy Agok",
      "Maryam Rahimie"
    ]
  },
  {
    "name": "Wylie",
    "lat": 31,
    "lng": -99,
    "n": 3,
    "people": [
      "Raegan Smith",
      "Mattea Gallaway",
      "Nico Hutchinson"
    ]
  },
  {
    "name": "Phoenix",
    "lat": 33.46333333333333,
    "lng": -112.02333333333333,
    "n": 3,
    "people": [
      "Isabel Ramirez",
      "Noah Neitch",
      "Marcus Heatherly"
    ]
  },
  {
    "name": "Baltimore",
    "lat": 39.9025,
    "lng": -76.91,
    "n": 4,
    "people": [
      "Brandon Gladfelter",
      "Jawaan",
      "Aiden Miller",
      "Tamia"
    ]
  },
  {
    "name": "Miami",
    "lat": 25.76,
    "lng": -80.19,
    "n": 4,
    "people": [
      "Eliza Arnold",
      "Natasha Do Valle",
      "Celeste Ocampo",
      "Alfonsina Santucho"
    ]
  },
  {
    "name": "Austin",
    "lat": 30.27,
    "lng": -97.74,
    "n": 4,
    "people": [
      "Rodney",
      "Grace Vitale",
      "Brody Tighe",
      "Ezequiel Castaneda"
    ]
  },
  {
    "name": "Chicago",
    "lat": 42.105,
    "lng": -87.70333333333332,
    "n": 6,
    "people": [
      "Ava Wales",
      "Ting Ting Chen",
      "Adam Thies",
      "Blake Berry",
      "Laney Marquette",
      "Cole Dubrow"
    ]
  },
  {
    "name": "Houston",
    "lat": 29.764285714285712,
    "lng": -95.43428571428572,
    "n": 7,
    "people": [
      "Isabel Soliman",
      "Harshini Kaparaju",
      "Nhu Nguyen",
      "Nafisa Rahman",
      "Vicki Vargas",
      "Doreen Otaru",
      "Jadyn Wu"
    ]
  },
  {
    "name": "Thousand Oaks",
    "lat": 34.51625,
    "lng": -119.22000000000001,
    "n": 8,
    "people": [
      "Madilyn Palosi",
      "Caterina Terrizzi",
      "Destiny Ramos",
      "Juno Azuz Zacher",
      "Ethan Schwesinger",
      "Kristin Rosenmund",
      "Ethan Buhain",
      "Lydia"
    ]
  },
  {
    "name": "Atlanta",
    "lat": 33.75,
    "lng": -84.39,
    "n": 9,
    "people": [
      "Vianne NguyenVianne Nguyen",
      "Kayla McIntyre",
      "Jeremiah Baker",
      "Anna Zhai",
      "Genae Horst",
      "Sydney Blair",
      "Christia'n Jarvis",
      "Grace An"
    ]
  },
  {
    "name": "Tampa",
    "lat": 27.85444444444444,
    "lng": -81.81777777777778,
    "n": 9,
    "people": [
      "Briana Rivera",
      "Jake Stalvey",
      "Kimberly Locke",
      "Mia Oklin",
      "Gracielly",
      "Tristan Britton-Harr",
      "Sofia V",
      "Ava Wilson"
    ]
  },
  {
    "name": "Cupertino",
    "lat": 36.779999999999994,
    "lng": -119.42,
    "n": 10,
    "people": [
      "Richard Zhang",
      "Zachary Camat",
      "Josie Fontana",
      "Molly McLean",
      "Taya",
      "Savannah Gasca",
      "John Dorian",
      "Braeden Bailey"
    ]
  },
  {
    "name": "San Francisco",
    "lat": 37.86799999999999,
    "lng": -122.16800000000002,
    "n": 15,
    "people": [
      "Caroline Mark",
      "Gavin Griffin",
      "Aidan Teeling",
      "Kalen Kang",
      "Daniel Pan",
      "Leanna",
      "Andray Lamba",
      "Taniya Kumar"
    ]
  },
  {
    "name": "Philadelphia",
    "lat": 40.29315789473685,
    "lng": -74.52157894736843,
    "n": 19,
    "people": [
      "Emma Choy",
      "Leslie Lacy",
      "Emerson Eby",
      "Sam",
      "Alexi Haimes",
      "Ziyu Gao",
      "Mulang Zhu",
      "Alexandra Donsky"
    ]
  },
  {
    "name": "Irvine",
    "lat": 33.4424,
    "lng": -117.65559999999998,
    "n": 25,
    "people": [
      "Brandon Liu",
      "Junior Contreras",
      "Chloe Osmers",
      "Amelia Kosmal",
      "Jenae Sperling",
      "Amishi",
      "Eugene Choi",
      "Molly Riehle"
    ]
  },
  {
    "name": "Los Angeles",
    "lat": 34.038085106382994,
    "lng": -118.22117021276587,
    "n": 94,
    "people": [
      "Grace Carr",
      "Inka",
      "Thomas Kleist",
      "Maggie Lee",
      "Connor James",
      "Kate Honsik",
      "Kelly R",
      "Lance Caparas"
    ]
  }
];
export const UNPLACED_HOMETOWNS = 82;

/** Seed the scene from the baked room. Call once, before mounting PeplGraph. */
export function seedScene(nodes: RoomNode[], edges: RoomEdge[] = []): GraphAdapter {
  const a = new RoomAdapter(nodes);
  defaultAdapter = a;
  /* threads only between people who actually stand in the room */
  const present = new Set(nodes.map((n) => n.id));
  ROOM_EDGES = edges.filter((e) => present.has(e.s) && present.has(e.t));
  GUEST_DETAILS = a.details();
  TICKER_SCHOOLS = tally(nodes.map((n) => n.school));
  TICKER_COMPANIES = tally(nodes.map((n) => n.company)).map((c) => {
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    // `domain` gates the <img> in TagTicker — only set it when the file
    // actually exists, or the ticker renders broken-image boxes.
    return LOGO_SLUGS.has(slug) ? { ...c, slug, domain: slug } : { ...c, slug };
  });
  const seen = new Set<string>();
  SCHOOL_COMPANY_PAIRS = [];
  for (const n of nodes) {
    const school = (n.school ?? "").trim();
    const company = (n.company ?? "").trim();
    if (!school || !company) continue;
    const k = `${school}|${company}`;
    if (seen.has(k)) continue;
    seen.add(k);
    SCHOOL_COMPANY_PAIRS.push({ school, company, n: 1 });
  }
  return a;
}
