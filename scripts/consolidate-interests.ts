// scripts/consolidate-interests.ts — merge near-duplicate Interest tags into canonical
// umbrellas so shared semantic ground actually BRIDGES people. LLM proposes the mapping;
// code applies it deterministically; the Interest layer is rewritten through the gate.
import { z } from "zod";
import { chat, type ChatMessage } from "@/lib/gateway";
import { run } from "@/lib/neo4j";
import { dispatch } from "@/lib/ontology-gate";

const STRONG = process.env.BUTTERBASE_STRONG_MODEL || "openai/gpt-4o";

const MapSchema = z.object({
  mappings: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).min(10),
});

async function main() {
  const rows = await run(
    `MATCH (p:Person)-[:INTERESTED_IN]->(i:Interest) RETURN p.id AS pid, collect(i.name) AS tags`,
  );
  const personTags = new Map<string, string[]>(
    rows.records.map((r) => [String(r.get("pid")), (r.get("tags") as string[]) ?? []]),
  );
  const all = [...new Set([...personTags.values()].flat())].sort();
  console.log(`consolidating ${all.length} distinct tags across ${personTags.size} people`);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You consolidate interest tags for one party crowd. Given the full tag list, map near-duplicates, " +
        "synonyms, and overly-specific variants onto SHARED canonical umbrella tags (lowercase, 1-3 words, " +
        "concrete: 'animation', 'game design', 'social impact', 'live music', 'urban culture', 'wearables', " +
        "'sustainability', 'documentary film', 'graph tech'). Target 60-110 canonical tags total. Only map " +
        "when honest — a tag with no near neighbor stays itself (omit it). Respond ONLY JSON " +
        '{"mappings":[{"from":"<existing tag>","to":"<canonical tag>"}]}.',
    },
    { role: "user", content: `Tags:\n${all.join("\n")}` },
  ];
  const out = await chat(STRONG, messages, MapSchema);
  const mapping = new Map<string, string>();
  for (const m of out.mappings) {
    const from = m.from.toLowerCase().trim();
    const to = m.to.toLowerCase().trim().replace(/[^a-z\- ]/g, "");
    if (from && to && to.split(" ").length <= 3) mapping.set(from, to);
  }
  console.log(`mapping covers ${mapping.size} tags`);

  // maintenance: clear the Interest layer, then rewrite canonically through the gate
  await run(`MATCH (i:Interest) DETACH DELETE i`);
  const counts = new Map<string, number>();
  let written = 0;
  for (const [pid, tags] of personTags) {
    const canon = [...new Set(tags.map((t) => mapping.get(t) ?? t))].slice(0, 4);
    if (canon.length === 0) continue;
    await dispatch("write_interests", { personId: pid, interests: canon }, { src: "semantic:consolidated", actor: "pipeline" });
    for (const t of canon) counts.set(t, (counts.get(t) ?? 0) + 1);
    written++;
  }
  const shared = [...counts.values()].filter((n) => n >= 2).length;
  console.log(
    `rewritten: ${written} people · ${counts.size} distinct tags · ${shared} shared by >=2 · unique-ratio ${(100 * (1 - shared / Math.max(1, counts.size))).toFixed(0)}%`,
  );
  console.log("top:", [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t}(${n})`).join(" · "));
}

main().then(() => process.exit(0)).catch((e) => { console.error("consolidate FAILED —", e); process.exit(1); });
