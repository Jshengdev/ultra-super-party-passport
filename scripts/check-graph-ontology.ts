// scripts/check-graph-ontology.ts
import { ACTIONS, LINKS, OBJECT_SCHEMAS } from "../ontology/manifest";
const fail = (m: string) => { console.error("FAIL:", m); process.exit(1); };
if (!(OBJECT_SCHEMAS as Record<string, unknown>)["Place"]) fail("Place label missing");
if (!(OBJECT_SCHEMAS as Record<string, unknown>)["Inspiration"]) fail("Inspiration label missing");
const rel = (r: string) => (LINKS as readonly { rel: string }[]).some(l => l.rel === r);
if (!rel("FROM") || !rel("INSPIRED_BY") || !rel("SEEKS")) fail("link missing (FROM/INSPIRED_BY/SEEKS)");
const act = (a: string) => (ACTIONS as Record<string, unknown>)[a] !== undefined;
if (!act("ingest_guest_v2") || !act("write_seek_edge")) fail("action missing");
console.log("graph ontology OK");
