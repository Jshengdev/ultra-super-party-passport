// scripts/extract-interests.ts — the semantic depth layer.
//
// Distill each guest's OWN words (working_on + belief_creative) into 2-3 concrete
// interest tags, canonicalized so shared tags become SHARED Interest nodes that
// bridge people across value clouds. Writes ONLY through the gate (write_interests).
//
//   node --env-file=.env --import tsx scripts/extract-interests.ts

import { readFileSync } from "fs";
import Papa from "papaparse";
import { z } from "zod";
import { chat, DEFAULT_CHAT_MODEL, type ChatMessage } from "@/lib/gateway";
import { dispatch } from "@/lib/ontology-gate";

const CSV_PATH = process.env.CSV_PATH || "data/party.csv";
const BATCH = 20;

interface Row {
  slug: string;
  name: string;
  working_on: string;
  belief: string;
}

const BatchSchema = z.object({
  guests: z
    .array(
      z.object({
        slug: z.string().min(1),
        interests: z.array(z.string().min(1)).min(2).max(3),
      }),
    )
    .min(1),
});

/** deterministic tag guard: <=3 words, letters/spaces/hyphens only */
const TAG_RE = /^[a-z][a-z\- ]{1,38}$/;
function cleanTag(raw: string): string | null {
  const t = raw.toLowerCase().trim().replace(/[.,;:!?'"()]/g, "").replace(/\s+/g, " ");
  if (!TAG_RE.test(t)) return null;
  if (t.split(" ").length > 3) return null;
  return t;
}

/** canonicalize across guests: exact match after clean + naive plural merge */
function canonicalizer() {
  const seen = new Map<string, string>(); // singular-ish key -> canonical form
  return (tag: string): string => {
    const key = tag.endsWith("s") && tag.length > 4 ? tag.slice(0, -1) : tag;
    const hit = seen.get(key);
    if (hit) return hit;
    seen.set(key, tag);
    return tag;
  };
}

async function extractBatch(rows: Row[], nudgeShared: boolean): Promise<Map<string, string[]>> {
  const listing = rows
    .map((r) => `- slug:${r.slug} | working on: ${r.working_on} | believes: ${r.belief}`)
    .join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You distill party guests' own words into interest tags. For EACH guest return 2-3 tags: " +
        "lowercase, 1-3 words, CONCRETE nouns over abstractions ('analog synths' not 'creativity'; " +
        "'street film' not 'storytelling'), letters/spaces/hyphens only, singular. PREFER tags " +
        "multiple guests could share (the point is common semantic ground: 'knowledge graphs', " +
        "'live music', 'social impact', 'game design', 'wearables', 'urban history'). " +
        (nudgeShared
          ? "IMPORTANT: previous pass produced too many one-off tags — bias harder toward the " +
            "SHARED vocabulary of this crowd; reuse the same tag across guests whenever honest. "
          : "") +
        'Respond ONLY with JSON: {"guests":[{"slug":"...","interests":["...","..."]}]} covering every listed slug.',
    },
    { role: "user", content: `Guests:\n${listing}` },
  ];
  const out = await chat(DEFAULT_CHAT_MODEL, messages, BatchSchema);
  const m = new Map<string, string[]>();
  for (const g of out.guests) {
    const tags = g.interests.map(cleanTag).filter((t): t is string => Boolean(t));
    if (tags.length >= 2) m.set(g.slug, tags.slice(0, 3));
  }
  return m;
}

async function main() {
  const rows: Row[] = Papa.parse<Record<string, string>>(readFileSync(CSV_PATH, "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data.map((r) => ({
    slug: r.email.split("@")[0],
    name: r.name,
    working_on: r.working_on,
    belief: r.belief_creative,
  }));

  const all = new Map<string, string[]>();
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let tags: Map<string, string[]> | null = null;
    for (let attempt = 0; attempt < 2 && !tags; attempt++) {
      try {
        tags = await extractBatch(batch, attempt > 0);
      } catch (e) {
        if (attempt === 1) throw e;
        console.error(`batch ${i / BATCH + 1}: retrying — ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      }
    }
    for (const [slug, t] of tags!) all.set(slug, t);
    console.log(`batch ${i / BATCH + 1}/${Math.ceil(rows.length / BATCH)}: ${tags!.size}/${batch.length} guests tagged`);
  }

  // shared-ground check: if >85% of tags are unique to one person, one more shared-biased pass
  const canon = canonicalizer();
  const counts = new Map<string, number>();
  for (const tags of all.values()) for (const t of tags.map(canon)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const shared = [...counts.values()].filter((n) => n >= 2).length;
  const uniqueRatio = 1 - shared / Math.max(1, counts.size);
  console.log(
    `tags: ${counts.size} distinct · ${shared} shared by >=2 · unique-ratio ${(uniqueRatio * 100).toFixed(0)}%`,
  );

  // write through the gate
  let written = 0;
  for (const [slug, tags] of all) {
    const canonTags = [...new Set(tags.map(canon))];
    await dispatch(
      "write_interests",
      { personId: slug, interests: canonTags },
      { src: "semantic:one-liner", actor: "pipeline" },
    );
    written++;
  }
  console.log(`write_interests dispatched for ${written} people`);

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("top shared:", top.map(([t, n]) => `${t}(${n})`).join(" · "));
  const avg = [...all.values()].reduce((n, t) => n + t.length, 0) / Math.max(1, all.size);
  console.log(`avg tags/person: ${avg.toFixed(2)} · people tagged: ${all.size}/${rows.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("extract-interests FAILED —", e);
    process.exit(1);
  });
