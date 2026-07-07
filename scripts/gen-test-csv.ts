/**
 * scripts/gen-test-csv.ts — deterministic ~40-row LA-creatives party CSV.
 *
 * Beliefs are drawn from FOUR latent value themes (craft, community, authenticity,
 * disruption) with distinct vocabulary so app-side embedding+clustering finds real
 * structure (>=2 clusters of >=2). what_you_do uses a controlled activity vocab so
 * people SHARE Activity nodes (the same-work passport find has real path receipts).
 * A handful of working_on lines are standout facts for hidden-prompt material.
 *
 * Seeded RNG → byte-identical output every run. Writes data/test-party.csv.
 * No creds required.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Papa from "papaparse";

const OUT = "data/test-party.csv";
const SEED = 0x50617274; // "Part"

/* deterministic PRNG (mulberry32) */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

const FIRST = [
  "Maya", "Leo", "Priya", "Dante", "Sofia", "Kai", "Noor", "Theo", "Imani", "Diego",
  "Elena", "Marcus", "Yuki", "Amara", "Rafael", "Chloe", "Omar", "Isla", "Tariq", "Nina",
  "Julian", "Zara", "Andre", "Lena", "Mateo", "Ava", "Rohan", "Camille", "Ezra", "Bianca",
  "Simone", "Nikhil", "Frida", "Cole", "Aisha", "Bruno", "Vera", "Malik", "Odette", "Sam",
];
const LAST = [
  "Rivera", "Nguyen", "Patel", "Okafor", "Kim", "Silva", "Haddad", "Rossi", "Cohen", "Mori",
  "Delgado", "Bauer", "Ferreira", "Osei", "Larsen", "Reyes", "Khan", "Petrov", "Adeyemi", "Ito",
];

const SCHOOLS: Record<string, string> = {
  USC: "usc.edu",
  UCLA: "ucla.edu",
  ArtCenter: "artcenter.edu",
  "SCI-Arc": "sciarc.edu",
  CalArts: "calarts.edu",
  Otis: "otis.edu",
};
const SCHOOL_NAMES = Object.keys(SCHOOLS);

const MAJORS = [
  "Film Production", "Graphic Design", "Music Composition", "Fashion Design",
  "Interaction Design", "Photography", "Fine Art", "Animation", "Architecture", "Illustration",
];

// controlled activity vocab → people share Activity nodes → same-work paths exist
const ACTIVITIES = [
  "filmmaker", "graphic designer", "musician", "fashion designer", "AI artist", "photographer",
];

const WORKING_ON = [
  "a short film about my grandmother's last summer in Manila",
  "a zine that only prints at 3am",
  "an album recorded entirely inside a parking garage for the reverb",
  "a fashion line made from decommissioned parachutes",
  "a generative art series trained on my childhood drawings",
  "a documentary about the last neon sign shop in LA",
  "a photo book of every taco truck on Sunset",
  "an app that turns your heartbeat into a synth line",
  "a puppet opera about climate grief",
  "a typeface based on my dad's handwriting",
  "a rooftop screening series for films that never got distribution",
  "a modular synth built from thrifted calculators",
  "a mural project across every laundromat in Echo Park",
  "a VR piece you can only experience lying down",
  "a cookbook where every recipe is a breakup story",
  "a sneaker made entirely of mushroom leather",
  // standout facts for hidden prompts:
  "training for a solo free climb of El Capitan this fall",
  "I climbed the outside of the Salesforce Tower once (please don't tell OSHA)",
  "restoring a 1972 Airstream into a mobile darkroom",
  "I hitchhiked from LA to Portland with only a Polaroid and a tent",
];

// FOUR value themes — distinct vocabulary so embeddings separate cleanly.
const THEMES: { key: string; beliefs: string[] }[] = [
  {
    key: "craft",
    beliefs: [
      "Creativity is just discipline in disguise — you show up every day and the ideas follow.",
      "Great work comes from repetition; talent is overrated, reps are everything.",
      "Mastery is earned in the boring hours. Craft beats inspiration every single time.",
      "The muse shows up for people who practice. Consistency is my whole creative philosophy.",
      "Skill compounds. I trust the daily process more than any burst of genius.",
      "Creativity is a muscle — you train it with reps, not by waiting for lightning.",
      "I'd rather out-practice everyone than out-talk them. Ten thousand hours is real.",
      "Good taste is built by making a thousand bad things first. Volume is the teacher.",
      "I don't wait to feel inspired — I sit down, do the reps, and refine until it's right.",
      "Discipline is the engine; inspiration is just the exhaust.",
    ],
  },
  {
    key: "community",
    beliefs: [
      "Nothing great is made alone. Every project I love came out of a room full of people.",
      "Creativity is a team sport; the best ideas are the ones we build together.",
      "I make things to bring people together — the work is an excuse for the community.",
      "Scenes make artists. I care more about the collective than any single genius.",
      "Collaboration multiplies you. I'd rather build with friends than shine alone.",
      "The magic is in the room — creativity happens between people, not inside one head.",
      "I believe in generosity: share the process, share the credit, and the whole scene rises.",
      "My best work is a conversation. Art is a group project pretending to be a solo one.",
      "Community is the medium. I make things that only exist because we made them together.",
      "Give your ideas away and you get ten back. Collaboration is my creative religion.",
    ],
  },
  {
    key: "authenticity",
    beliefs: [
      "The only work that matters is honest work — creativity is telling the truth out loud.",
      "I make things from the parts of me that scare me. Vulnerability is the whole point.",
      "Art is emotional honesty. If it doesn't cost me something real, it isn't finished.",
      "Creativity is being seen. I'd rather make one raw true thing than a hundred polished ones.",
      "The truest work is the most personal. I mine my own life for everything I make.",
      "I believe in radical honesty on the page. Feelings first, craft second.",
      "Making art is confessing. The more it exposes me, the more it connects.",
      "Authenticity beats perfection. I want my work to feel like a diary left open.",
      "Every piece I make is a small act of courage — saying the thing I'm afraid to say.",
      "Emotional truth is the only currency. I create to feel less alone, and to help others.",
    ],
  },
  {
    key: "disruption",
    beliefs: [
      "Rules are defaults waiting to be broken. I create to see what nobody has tried yet.",
      "I chase the weird and the new — creativity is running the experiment everyone skipped.",
      "The best ideas look broken at first. I'd rather fail at something new than nail the obvious.",
      "Technology is my paintbrush; I want to make things that couldn't exist a year ago.",
      "Novelty is the whole game. If it's been done, I've already lost interest.",
      "I build the future by breaking the present. Disruption is my creative default.",
      "Constraints are prompts, not walls. I hack the medium until it does something strange.",
      "Give me the tool nobody understands yet and I'll make something no one expected.",
      "I treat every project like an experiment — hypothesis, chaos, and an unpredicted result.",
      "The edge is the only place worth working. I make art that argues with what's normal.",
    ],
  },
];

const ROWS = 40;

function handle(first: string, last: string, i: number, kind: "ig" | "x"): string {
  const base = `${first}${last}`.toLowerCase();
  return kind === "ig" ? `@${base}.${i}` : `@${base}${i}`;
}

interface Out {
  name: string;
  email: string;
  school: string;
  major: string;
  what_you_do: string;
  working_on: string;
  instagram: string;
  x_handle: string;
  belief_creative: string;
}

const rows: Out[] = [];
// per-theme phrasing cursor so each person in a theme gets a distinct belief
const themeCursor = [0, 0, 0, 0];

for (let i = 0; i < ROWS; i++) {
  const first = pick(FIRST);
  const last = pick(LAST);
  const themeIdx = i % THEMES.length; // 10 people per theme, balanced
  const theme = THEMES[themeIdx];
  const belief = theme.beliefs[themeCursor[themeIdx] % theme.beliefs.length];
  themeCursor[themeIdx]++;

  const school = pick(SCHOOL_NAMES);
  const domain = SCHOOLS[school];
  const name = `${first} ${last}`;
  const email = `${first}.${last}${i}`.toLowerCase() + `@${domain}`;

  rows.push({
    name,
    email,
    school,
    major: pick(MAJORS),
    what_you_do: pick(ACTIVITIES),
    working_on: pick(WORKING_ON),
    instagram: handle(first, last, i, "ig"),
    x_handle: handle(first, last, i, "x"),
    belief_creative: belief,
  });
}

const csv = Papa.unparse(rows, {
  columns: [
    "name", "email", "school", "major", "what_you_do",
    "working_on", "instagram", "x_handle", "belief_creative",
  ],
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, csv + "\n", "utf8");
console.log(`gen-test-csv: wrote ${rows.length} rows to ${OUT} (seed ${SEED})`);
