/**
 * scripts/precache.ts — the invisible pre-processing pass.
 *
 * Reads the REAL event export (Luma-style CSV: Name / Status / RSVP date / school / major /
 * grad year), normalizes the messy fields (IYA is spelled six ways in the wild), and enriches
 * each guest from the persona-archetype library (data/archetypes.json — simulated event-goer
 * families so attendees see a reflection of themselves). Assignment is DETERMINISTIC:
 * fnv1a(name) picks within a major-weighted family list, so re-runs are stable.
 *
 * Output: data/party.csv in the app's canonical shape (+ status column), ready for
 * `CSV_PATH=data/party.csv npm run ingest`. Every derived field is exactly that — derived;
 * the graph writes carry _src='csv:party' provenance and the enrichment is marked here.
 *
 *   npx tsx scripts/precache.ts <input.csv> [output.csv]
 */
import { readFileSync, writeFileSync } from "fs";
import Papa from "papaparse";

type Row = Record<string, string>;
interface Persona { what_you_do: string; working_on: string; belief_creative: string }
interface Family { family: string; belief_theme: string; personas: Persona[] }

const [, , INPUT = "/Users/johnnysheng/Downloads/IYAWELCOMEBACKPARTY_7-03_guests-2.csv", OUTPUT = "data/party.csv"] =
  process.argv;

const families: Family[] = JSON.parse(readFileSync("data/archetypes.json", "utf8")).families;
if (!families?.length) throw new Error("precache: data/archetypes.json missing or empty — run the persona swarm first");

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normSchool(raw: string): string {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return "USC";
  if (s.includes("iya") || s.includes("iovine")) return "Iovine & Young Academy";
  if (s.includes("dornsife")) return "Dornsife";
  if (s.includes("viterbi")) return "Viterbi";
  if (s.includes("marshall")) return "Marshall";
  if (s.includes("annenberg")) return "Annenberg";
  if (s.includes("roski")) return "Roski";
  if (s.includes("thornton")) return "Thornton";
  if (s.includes("cinema") || s.includes("sca")) return "Cinematic Arts";
  if (s.includes("architecture")) return "Architecture";
  return raw.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

function normMajor(raw: string): string {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return "Undeclared";
  if (s.includes("iya") || s === "acad" || (s.includes("art") && s.includes("tech")) || s.includes("atb"))
    return "Arts, Technology & the Business of Innovation";
  if (s.includes("comp") && s.includes("sci")) return "Computer Science";
  if (s.includes("econ")) return "Economics";
  if (s.includes("business")) return "Business Administration";
  if (s.includes("design")) return "Design";
  if (s.includes("film") || s.includes("cinema")) return "Film & Media";
  if (s.includes("comm")) return "Communication";
  return raw.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

function gradYear(raw: string): string {
  const m = (raw || "").match(/20\d\d/);
  return m ? m[0] : "";
}

/** major-category → weighted family keys (reflection needs variety: IYA spreads everywhere). */
function familyWeights(major: string, school: string): string[] {
  const M = major.toLowerCase();
  const all = families.map((f) => f.family);
  const w = (...keys: string[]) => keys.filter((k) => all.includes(k));
  if (M.includes("arts, technology")) return w("maker-builders", "aesthetes", "storytellers", "community-weavers", "world-changers", "systems-minds");
  if (M.includes("computer") || M.includes("engineering")) return w("systems-minds", "maker-builders", "world-changers");
  if (M.includes("econom") || M.includes("business")) return w("systems-minds", "community-weavers", "world-changers");
  if (M.includes("film") || M.includes("media") || M.includes("comm")) return w("storytellers", "community-weavers", "aesthetes");
  if (M.includes("design") || school.includes("Roski")) return w("aesthetes", "maker-builders", "storytellers");
  if (school.includes("Thornton")) return w("storytellers", "aesthetes");
  return all;
}

const raw = Papa.parse<Row>(readFileSync(INPUT, "utf8"), { header: true, skipEmptyLines: true });
const seen = new Set<string>();
const out = raw.data
  .filter((r) => (r["Name"] || "").trim())
  .map((r) => {
    const name = r["Name"].trim();
    const school = normSchool(r["Which USC school are you in?"]);
    const major = normMajor(r["What’s your major?"] ?? r["What's your major?"] ?? "");
    const year = gradYear(r["Grad year?"]);
    const status = (r["Status"] || "").trim().toLowerCase() === "approved" ? "approved" : "pending";
    const h = fnv1a(name);
    const weights = familyWeights(major, school);
    const fam = families.find((f) => f.family === weights[h % weights.length]) ?? families[h % families.length];
    const persona = fam.personas[(h >>> 8) % fam.personas.length];
    let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `guest-${h % 1000}`;
    while (seen.has(slug)) slug = `${slug}-${(h % 97).toString(36)}`;
    seen.add(slug);
    return {
      name,
      email: `${slug}@guests.usp.party`, // placeholder — the export carries no emails
      school,
      major: year ? `${major} '${year.slice(2)}` : major,
      what_you_do: persona.what_you_do,
      working_on: persona.working_on,
      instagram: "",
      x_handle: "",
      belief_creative: persona.belief_creative,
      status,
    };
  });

writeFileSync(OUTPUT, Papa.unparse(out));
const approved = out.filter((r) => r.status === "approved").length;
console.log(
  `precache: ${out.length} guests normalized+enriched → ${OUTPUT} (${approved} approved / ${out.length - approved} pending; ${families.length} persona families)`,
);
