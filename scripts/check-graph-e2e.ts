/**
 * scripts/check-graph-e2e.ts — the end-to-end flow gate: the whole circle, served.
 *
 * Every other gate reads files off disk. This one stands up an HTTP server over the
 * static export (`out/`) and proves the circle closes through the wire:
 *
 *   the room loads  →  the room's data is the right room  →  a person's record is
 *   reachable  →  and a receipt rendered in that record traces back, VERBATIM, to
 *   the cell in the guest sheet it was quoted from.
 *
 * That last leg is the point. A `why` with no edge behind it is a bug (CLAUDE.md law
 * c); this gate re-loads the raw CSV through `lib/guests` and re-reads the quotes out
 * of the source fields, so "RECEIPT RESOLVED" in the UI is an assertion, not a claim.
 *
 * On the drop-zone assertion: `app/graph/page.tsx` mounts PartyScene with `ssr:false`
 * (it touches window/document from first paint), so the Step-0 markup is NOT in
 * graph.html — the HTML ships the boot shell and the entry lives in a lazily-loaded
 * chunk. Asserting only on the HTML would therefore be a lie by omission. Instead we
 * walk the real load path over HTTP: graph.html → its webpack runtime (chunk id→hash
 * map) + the graph page chunk → the lazy chunk it requires → and assert the Step-0
 * strings are actually served to the browser.
 *
 * Prereqs: a STATIC_EXPORT build (see scripts/deploy-static.sh) so `out/` exists, and
 * GUESTS_CSV pointing at the guest sheet. Exits non-zero on any failure.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { loadGuests, type Guest } from "../lib/guests";

const OUT = "out";
const POP = 312;
const TJ = /\btj\b/i;

class E2eError extends Error {
  constructor(leg: string, msg: string) {
    super(`[${leg}] ${msg}`);
    this.name = "E2eError";
  }
}
const need = (leg: string, ok: boolean, msg: string) => {
  if (!ok) throw new E2eError(leg, msg);
};

/* ------------------------------------------------- the server (out/, ext-fallback) */
const TYPES: Record<string, string> = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };

function resolveFile(urlPath: string): string | null {
  const rel = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  for (const cand of [join(OUT, rel), `${join(OUT, rel)}.html`, join(OUT, rel, "index.html")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const server = createServer(async (req, res) => {
  const file = resolveFile(req.url ?? "/");
  if (!file) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
});

/* ------------------------------------------------------------------ the assertions */
interface Receipt {
  yours: { field: string; quote: string };
  theirs: { field: string; quote: string };
}
interface PersonEdge {
  targetId: string;
  type: string;
  direction: string;
  strength: number;
  via: string;
  receipt: Receipt;
}

/** The one field the emitter renders as a composite: `title — goal`. */
const COMPOSITE = "title";
const DASH = " — ";

/** Read the raw source string a receipt field names, straight off the CSV-loaded guest. */
function sourceField(g: Guest, field: string): string {
  if (field === COMPOSITE) return g.title;
  const a = g.answers as unknown as Record<string, string | undefined>;
  const v = a[field];
  if (typeof v !== "string") throw new E2eError("receipt", `receipt names field "${field}" which is not a guest answer field`);
  return v;
}

/** A receipt side traced back to the sheet. Composite sides split on the first em-dash. */
function traceSide(leg: string, who: string, g: Guest, side: { field: string; quote: string }): string {
  if (side.field === COMPOSITE) {
    const i = side.quote.indexOf(DASH);
    need(leg, i > 0, `${who}: composite receipt quote has no "${DASH.trim()}" separator: ${JSON.stringify(side.quote)}`);
    const title = side.quote.slice(0, i);
    const goal = side.quote.slice(i + DASH.length);
    need(leg, g.title.includes(title), `${who}: receipt title ${JSON.stringify(title)} is NOT verbatim in CSV title ${JSON.stringify(g.title)}`);
    need(leg, g.answers.goal.includes(goal), `${who}: receipt goal ${JSON.stringify(goal)} is NOT verbatim in that guest's CSV goal answer`);
    return `title+goal (${title})`;
  }
  const src = sourceField(g, side.field);
  need(leg, src.includes(side.quote), `${who}: receipt quote is NOT verbatim in CSV field "${side.field}": ${JSON.stringify(side.quote.slice(0, 60))}`);
  return side.field;
}

async function main(): Promise<void> {
  const csv = process.env.GUESTS_CSV;
  need("env", !!csv, "GUESTS_CSV is not set — the closing loop needs the raw guest sheet");
  need("env", existsSync(OUT), `no "${OUT}/" — run the STATIC_EXPORT build first (scripts/deploy-static.sh)`);

  const guests = loadGuests(csv!);
  const byId = new Map(guests.map((g) => [g.personId, g]));
  const tj = guests.find((g) => TJ.test(g.name));
  need("guests", !!tj, "no guest whose name matches /\\btj\\b/ — cannot run the closing loop");

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const get = async (p: string) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.text() };
  };

  /* -- 1. the room loads ------------------------------------------------------- */
  const page = await get("/graph.html");
  need("graph.html", page.status === 200, `GET /graph.html → ${page.status}`);
  need("graph.html", page.body.includes("assembling the room"), "graph.html is missing the boot shell");
  const pretty = await get("/graph");
  need("graph.html", pretty.status === 200, `GET /graph (ext-fallback, as static hosts serve it) → ${pretty.status}`);

  /* -- 1b. the Step-0 entry actually ships (lazy chunk, ssr:false — see header) -- */
  const scripts = [...new Set([...page.body.matchAll(/\/_next\/static\/chunks\/[\w./-]+\.js/g)].map((m) => m[0]))];
  need("entry", scripts.length > 0, "graph.html references no chunks");
  const runtimeUrl = scripts.find((s) => s.includes("/webpack-"));
  const pageChunkUrl = scripts.find((s) => s.includes("/app/graph/page-"));
  need("entry", !!runtimeUrl && !!pageChunkUrl, "graph.html is missing the webpack runtime or the graph page chunk");
  const runtime = await get(runtimeUrl!);
  const pageChunk = await get(pageChunkUrl!);
  need("entry", runtime.status === 200 && pageChunk.status === 200, "webpack runtime / graph page chunk did not serve 200");

  const map = [...runtime.body.matchAll(/(\d+):"([0-9a-f]{8,32})"/g)];
  const lazy = map.filter(([, id]) => new RegExp(`\\b${id}\\b`).test(pageChunk.body));
  need("entry", lazy.length > 0, "the graph page chunk requires no lazy chunk — PartyScene is not being loaded");

  let entryFoundIn = "";
  for (const [, id, hash] of lazy) {
    const url = `/_next/static/chunks/${id}.${hash}.js`;
    const c = await get(url);
    need("entry", c.status === 200, `GET ${url} → ${c.status} (referenced by the graph page chunk)`);
    if (c.body.includes("drop the guest list") && c.body.includes("The room is already built.")) entryFoundIn = url;
  }
  need("entry", entryFoundIn !== "", `the Step-0 drop-zone markup was not served by any chunk the graph page requires (looked in ${lazy.length})`);

  /* -- 2. the room's data is the right room ------------------------------------ */
  const gRes = await get("/graph/graph.json");
  need("graph.json", gRes.status === 200, `GET /graph/graph.json → ${gRes.status}`);
  const graph = JSON.parse(gRes.body) as { nodes: unknown[]; meta: { stages?: Record<string, number>; guestIds?: string[] } };
  need("graph.json", graph.nodes.length === POP, `nodes.length is ${graph.nodes.length}, expected ${POP}`);
  need("graph.json", !!graph.meta?.stages, "meta.stages is missing (the entry drop-zone reads it)");
  need("graph.json", graph.meta.stages!.unique === graph.nodes.length, `meta.stages.unique (${graph.meta.stages!.unique}) !== nodes.length (${graph.nodes.length})`);
  need("graph.json", Array.isArray(graph.meta?.guestIds), "meta.guestIds is missing");
  need("graph.json", graph.meta.guestIds!.length === POP, `meta.guestIds.length is ${graph.meta.guestIds!.length}, expected ${POP}`);

  /* -- 3. a person's record is reachable --------------------------------------- */
  const pRes = await get(`/graph/people/${tj!.personId}.json`);
  need("person", pRes.status === 200, `GET /graph/people/${tj!.personId}.json → ${pRes.status}`);
  const person = JSON.parse(pRes.body) as { personId: string; edges: PersonEdge[] };
  need("person", person.personId === tj!.personId, `record personId ${person.personId} !== ${tj!.personId}`);

  /* -- 4. THE CLOSING LOOP: a rendered receipt, back to the sheet -------------- */
  const seeks = person.edges.filter((e) => e.type === "seek").sort((a, b) => b.strength - a.strength);
  need("receipt", seeks.length > 0, `${tj!.name} has no seek edge to trace`);
  const top = seeks[0];
  const other = byId.get(top.targetId);
  need("receipt", !!other, `seek edge points at ${top.targetId}, who is not in the CSV`);
  need("receipt", !!top.receipt?.yours?.quote && !!top.receipt?.theirs?.quote, "top seek edge carries no receipt quotes");

  const yoursVia = traceSide("receipt", `${tj!.name} (yours)`, tj!, top.receipt.yours);
  const theirsVia = traceSide("receipt", `${other!.name} (theirs)`, other!, top.receipt.theirs);

  server.close();
  console.log(
    `e2e OK: served out/ on :${port} · /graph.html 200 (+ /graph) · Step-0 entry served from ${entryFoundIn} · ` +
      `graph.json ${graph.nodes.length} nodes = stages.unique, ${graph.meta.guestIds!.length} guestIds · ` +
      `/graph/people/${tj!.personId}.json 200 · closing loop: ${tj!.name} —[seek ${top.strength}]→ ${other!.name} ` +
      `receipt traced VERBATIM to the sheet (yours=${yoursVia}, theirs=${theirsVia})`
  );
}

main().catch((e) => {
  server.close();
  console.error(e instanceof E2eError ? `FAIL ${e.message}` : e);
  process.exit(1);
});
