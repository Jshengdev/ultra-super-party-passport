/**
 * scripts/enrich-matches.ts — the match leg: guests + convictions → the seek matrix → the gate.
 *
 * CSV → Guest[] + data/graph-private/convictions.json → embeddings (cached) → seek edges +
 * doppelgängers → `dispatch("write_seek_edge", …)` for EVERY edge (law a: the gate is the only
 * write path; there is no raw Cypher in this file) → data/graph-private/matches.json for the
 * emit leg. Doppelgängers are artifact-only: no manifest action declares them, so under law (a)
 * they are unrepresentable in the graph and stay in the JSON.
 *
 *   node --env-file=.env --import tsx scripts/enrich-matches.ts
 *   GUESTS_CSV=… GUESTS_FILTER=gst-a,gst-b node --env-file=.env --import tsx scripts/enrich-matches.ts
 *   DRY_RUN=1 GUESTS_CSV=… npx tsx scripts/enrich-matches.ts     # cache-only, no driver, no gateway
 *
 * PROVIDER. `EMBED_PROVIDER=gateway` (default) uses Butterbase embeddings. `EMBED_PROVIDER=tfidf`
 * uses the named local TF-IDF fallback — no gateway creds needed, no cache read or written — and
 * every edge it produces is stamped `_src = "match:tfidf-v1"` instead of `"gateway:seek-match"`,
 * so the graph itself records which vector space matched these people. The banner says it out loud.
 *
 * Env:
 *   EMBED_PROVIDER          (optional) gateway (default) | tfidf
 *   GUESTS_CSV              (required) path to the Luma guest export
 *   GUESTS_FILTER           (optional) comma-separated guest_ids — the golden-sample run
 *   CONVICTIONS_JSON        (optional) override data/graph-private/convictions.json
 *   EMBEDDINGS_JSON         (optional) override data/graph-private/embeddings.json (the vector cache)
 *   SEEK_PERCENTILE         (optional) per-row floor, default 0.90 — the ONE tunable constant
 *   SEEK_TOP_K              (optional) outbound cap per seeker, default 5 (balance directive)
 *   SEEK_WRITE_CONCURRENCY  (optional) parallel gate dispatches, default 6
 *   SEEK_DIAGNOSE           (optional) comma-separated guest NAMES; prints raw both-direction
 *                           scores + rank + row threshold for every pair among them.
 *                           Default: the GOLDEN_NAMES sample.
 *   DRY_RUN=1               (optional) compute from the embedding cache ONLY, print the SeekEdge
 *                           list that WOULD be dispatched (JSONL), validate all of it against the
 *                           manifest's WriteSeekEdgeParams, touch neither driver nor gateway, and
 *                           write NOTHING to disk. A cold cache is a named note + exit 0.
 *
 * Exit codes: 2 = DEGRADED (no gateway creds / no Neo4j creds / no GUESTS_CSV / no convictions)
 *             1 = the pass failed loud (a write failed, an edge targeted a Person not in the graph)
 *             0 = matrix written + every edge through the gate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadGuests, GOLDEN_NAMES, type Guest } from "../lib/guests";
import { CONVICTIONS_PATH, openSeekerBackstop, type Conviction } from "../lib/conviction";
import { isGatewayConfigured, GatewayNotConfigured } from "../lib/gateway";
import { isConfigured as isNeo4jConfigured, close, Neo4jNotConfigured } from "../lib/neo4j";
import { dispatch } from "../lib/ontology-gate";
import { WriteSeekEdgeParams } from "../ontology/manifest";
import {
  computeMatches, cosine, adaptiveThreshold, isOutboundSeeker, isSeekTarget, seekDoc, vectorProvider,
  EmbeddingsCacheMiss, UnknownVectorProvider, MATCHES_PATH, SEEK_PERCENTILE, SEEK_TOP_K,
  type Matches, type SeekEdge, type VectorProvider,
} from "../lib/matches";

/**
 * Provenance is per-provider (law d): the graph must record WHICH vector space decided that these
 * two people should find each other. `gateway:seek-match` = Butterbase embeddings;
 * `match:tfidf-v1` = the named local fallback. Never one label pretending to be the other.
 */
const PROV: Record<VectorProvider, { src: string; actor: "agent" }> = {
  gateway: { src: "gateway:seek-match", actor: "agent" },
  tfidf: { src: "match:tfidf-v1", actor: "agent" },
};

function num(env: string | undefined, dflt: number): number {
  const v = Number(env);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** Bounded-concurrency map — Aura Free is happier with 6 in flight than 970 at once. */
async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    }),
  );
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Deterministic backstop conviction for a guest the pass never wrote a record for. */
function fallbackConviction(g: Guest): Conviction {
  return {
    motive: null, mission: null, impact: null, aspiration: null,
    quotes: {},
    openSeeker: openSeekerBackstop(g.answers.seeking ?? ""),
  };
}

/** The acceptance-step diagnostic: raw both-direction scores for a named set of guests. */
function diagnose(
  names: string[],
  guests: Guest[],
  v: { ids: string[]; seekVecs: Array<number[] | null>; offerVecs: number[][]; targetable: boolean[] },
  percentile: number,
  say: (m: string) => void,
): void {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const picked = guests.map((g, i) => ({ g, i })).filter(({ g }) => want.has(g.name.toLowerCase()));
  if (picked.length < 2) return;

  const lines: string[] = [];
  for (const from of picked) {
    const sv = v.seekVecs[from.i];
    if (!sv) {
      lines.push(`  ${from.g.name} → (no outbound: openSeeker or blank seeking answer)`);
      continue;
    }
    // NaN marks a non-candidate — self, or a target nobody may be pointed at (isSeekTarget) — so
    // the printed rank and floor are over the SAME sample buildSeekEdges selected from.
    const row = v.ids.map((_, j) => (j === from.i || !v.targetable[j] ? Number.NaN : cosine(sv, v.offerVecs[j])));
    const cand = row.filter((x) => !Number.isNaN(x));
    const thr = adaptiveThreshold(cand, percentile);
    const ranked = [...cand].sort((a, b) => b - a);
    for (const to of picked) {
      if (to.i === from.i) continue;
      const s = row[to.i];
      if (Number.isNaN(s)) {
        lines.push(`  ${from.g.name} → ${to.g.name}: not a candidate (offer doc is the fallback — inbound-ineligible)`);
        continue;
      }
      const rank = ranked.findIndex((x) => x === s) + 1;
      lines.push(
        `  ${from.g.name} → ${to.g.name}: score ${s.toFixed(4)} · rank ${rank}/${cand.length} · ` +
          `p${(percentile * 100).toFixed(0)} floor ${thr.toFixed(4)} · ${s >= thr ? "over floor" : "UNDER FLOOR"}`,
      );
    }
  }
  if (lines.length) say(`\nSEEK_DIAGNOSE (${picked.length} guest(s) matched by name):\n${lines.join("\n")}`);
}

async function main(): Promise<number> {
  const dryRun = process.env.DRY_RUN === "1";
  // In DRY_RUN, stdout is the SeekEdge JSONL and NOTHING else — progress goes to stderr so the
  // list stays pipeable. In a live run, progress is the normal stdout log.
  const say: (m: string) => void = dryRun ? (m) => console.error(m) : (m) => console.log(m);
  const percentile = Number(process.env.SEEK_PERCENTILE) || SEEK_PERCENTILE;
  const topK = num(process.env.SEEK_TOP_K, SEEK_TOP_K);

  // The provider decides whether the gateway is needed at all. An unparseable EMBED_PROVIDER
  // throws UnknownVectorProvider here rather than silently defaulting to a different vector space.
  let provider: VectorProvider;
  try {
    provider = vectorProvider();
  } catch (e) {
    if (e instanceof UnknownVectorProvider) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  say(
    provider === "tfidf"
      ? "provider tfidf — gateway embeddings unavailable (named fallback); SEEKS provenance _src=match:tfidf-v1"
      : "provider gateway — Butterbase embeddings; SEEKS provenance _src=gateway:seek-match",
  );

  // ---- DEGRADED gates, cheapest first: no creds means a NAMED error and exit 2, never a fake pass.
  if (provider === "gateway" && !dryRun && !isGatewayConfigured()) {
    console.error(
      "GatewayNotConfigured: BUTTERBASE_GATEWAY_URL / BUTTERBASE_API_KEY missing — " +
        "DEGRADED mode, the seek matrix needs embeddings. (DRY_RUN=1 runs off the embedding cache.)",
    );
    return 2;
  }
  const csv = process.env.GUESTS_CSV;
  if (!csv) {
    console.error("GuestsCsvMissing: set GUESTS_CSV to the guest export path");
    return 2;
  }
  const convPath = process.env.CONVICTIONS_JSON || CONVICTIONS_PATH;
  if (!existsSync(convPath)) {
    console.error(
      `ConvictionsMissing: ${convPath} does not exist — run scripts/enrich-convictions.ts first ` +
        `(openSeeker and the \`via\` labels both come from it).`,
    );
    return 2;
  }
  if (!dryRun && !isNeo4jConfigured()) {
    const missing = ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"].filter((k) => !process.env[k]);
    console.error(new Neo4jNotConfigured(missing).message);
    return 2;
  }

  // ---- inputs
  let guests = loadGuests(csv);
  const total = guests.length;
  const filter = process.env.GUESTS_FILTER?.split(",").map((s) => s.trim()).filter(Boolean);
  if (filter?.length) {
    guests = guests.filter((g) => filter.includes(g.guestId));
    const found = new Set(guests.map((g) => g.guestId));
    const unmatched = filter.filter((id) => !found.has(id));
    if (unmatched.length) {
      // fail loud, same as the sibling legs: a golden run silently matching 9/10 is the bug.
      console.error(`GuestsFilterUnmatched: ${unmatched.length} guest_id(s) not in the CSV — ${unmatched.join(", ")}`);
      return 1;
    }
  }
  if (!guests.length) {
    console.error(`NoGuestsSelected: 0 of ${total} guests selected (check GUESTS_FILTER)`);
    return 1;
  }

  const raw = JSON.parse(readFileSync(convPath, "utf8")) as Record<string, Conviction>;
  const conv = new Map<string, Conviction>();
  const missingConv: string[] = [];
  for (const g of guests) {
    const c = raw[g.personId];
    if (c) conv.set(g.personId, c);
    else {
      // Not fatal — but never silent, and never a guessed openSeeker: fall back to the
      // deterministic regex backstop so a missing record can't mint an "anyone" edge.
      missingConv.push(g.personId);
      conv.set(g.personId, fallbackConviction(g));
    }
  }
  if (missingConv.length) {
    console.error(
      `ConvictionsIncomplete: ${missingConv.length}/${guests.length} guest(s) have no record in ${convPath} — ` +
        `using the deterministic openSeeker backstop for them: ${missingConv.slice(0, 10).join(", ")}` +
        `${missingConv.length > 10 ? ` …(+${missingConv.length - 10})` : ""}`,
    );
  }

  const openSeekers = guests.filter((g) => conv.get(g.personId)?.openSeeker).length;
  const blankSeeking = guests.filter((g) => !conv.get(g.personId)?.openSeeker && seekDoc(g) === "").length;
  say(
    `enrich-matches: ${guests.length}/${total} guest(s) · p${(percentile * 100).toFixed(0)} floor · top-${topK} cap · ` +
      `${openSeekers} openSeeker · ${blankSeeking} blank-seeking${dryRun ? " · DRY_RUN (cache only)" : ""}`,
  );

  // ---- compute
  const diagNames = (process.env.SEEK_DIAGNOSE?.split(",").map((s) => s.trim()).filter(Boolean)) ?? [...GOLDEN_NAMES];
  let matches: Matches;
  try {
    matches = await computeMatches(guests, conv, {
      provider,
      percentile,
      topK,
      cacheOnly: dryRun,
      embedPath: process.env.EMBEDDINGS_JSON || undefined,
      log: say,
      onVectors: (v) => diagnose(diagNames, guests, v, percentile, say),
    });
  } catch (e) {
    if (e instanceof EmbeddingsCacheMiss) {
      // DRY_RUN with a cold cache is not a failure — it is "nothing to show yet". Named note, exit 0.
      console.error(`DRY_RUN cannot proceed — ${e.message}`);
      return 0;
    }
    throw e;
  }

  const { seeks, doppels } = matches;

  // ---- total-outage tripwire, BEFORE anything is written: an empty matrix is never a result.
  if (seeks.length === 0) {
    console.error(
      `NoSeekEdges: 0 edges out of ${guests.length} guest(s) — every guest is an openSeeker, ` +
        `wrote no seeking answer, or the selection is over-tightened (SEEK_PERCENTILE=${percentile}). ` +
        `Nothing written.`,
    );
    return 1;
  }

  // ---- stats (the balance directive is auditable from this block alone)
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const e of seeks) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const mutualEdges = seeks.filter((e) => e.mutual).length;
  const scores = seeks.map((e) => e.score);
  const hubs = [...inDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const noInbound = guests.filter((g) => !inDeg.has(g.personId)).length;
  const outboundEligible = guests.filter((g) => isOutboundSeeker(g, conv.get(g.personId))).length;
  const inboundIneligible = guests.filter((g) => !isSeekTarget(g, conv.get(g.personId))).length;

  say(
    `\nseek matrix: ${seeks.length} edge(s) from ${outDeg.size}/${outboundEligible} seeker(s)\n` +
      `  mutual        ${mutualEdges} edge(s) = ${mutualEdges / 2} pair(s)\n` +
      `  out-degree    max ${Math.max(0, ...outDeg.values())} · min ${Math.min(topK, ...outDeg.values())} (cap ${topK})\n` +
      `  in-degree     max ${Math.max(0, ...inDeg.values())} · ${noInbound} guest(s) sought by nobody ` +
      `(${inboundIneligible} of them inbound-ineligible: fallback offer doc)\n` +
      `  score         min ${Math.min(...scores).toFixed(4)} · median ${median(scores).toFixed(4)} · max ${Math.max(...scores).toFixed(4)}\n` +
      `  most-sought   ${hubs.map(([id, n]) => `${id}(${n})`).join(", ")}\n` +
      `  doppelgängers ${doppels.length} pair(s)`,
  );

  // ---- the openSeeker invariant, re-asserted on the OUTPUT (not just trusted from the input)
  const illegal = seeks.filter((e) => conv.get(e.from)?.openSeeker);
  if (illegal.length) {
    console.error(`OpenSeekerLeak: ${illegal.length} outbound edge(s) from openSeeker guests — ${illegal.slice(0, 5).map((e) => e.from).join(", ")}`);
    return 1;
  }

  // ---- every edge must be representable at the gate BEFORE anything is written
  const invalid: string[] = [];
  for (const e of seeks) {
    const parsed = WriteSeekEdgeParams.safeParse(e);
    if (!parsed.success) {
      invalid.push(`${e.from}→${e.to}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
    }
  }
  if (invalid.length) {
    console.error(`INVALID against WriteSeekEdgeParams (${invalid.length}):\n${invalid.slice(0, 10).join("\n")}`);
    return 1;
  }

  if (dryRun) {
    for (const e of seeks) console.log(JSON.stringify(e));
    console.error(
      `DRY_RUN: ${seeks.length} SeekEdge(s) printed and validated against WriteSeekEdgeParams; ` +
        `${doppels.length} doppelgänger(s) computed; driver, gateway and disk all untouched.`,
    );
    return 0;
  }

  // ---- artifact FIRST: the embedding spend is the expensive part, a driver hiccup must not lose it
  mkdirSync(dirname(MATCHES_PATH), { recursive: true });
  writeFileSync(MATCHES_PATH, `${JSON.stringify({ seeks, doppels }, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${MATCHES_PATH} — ${seeks.length} seek edge(s), ${doppels.length} doppelgänger(s)`);

  // ---- the ONLY write path (law a) + provenance (law d)
  const failures: string[] = [];
  const unresolved: string[] = [];
  let ok = 0;
  await pool(seeks, num(process.env.SEEK_WRITE_CONCURRENCY, 6), async (e: SeekEdge) => {
    try {
      const written = await dispatch("write_seek_edge", e, PROV[provider]);
      // The action MATCHes both Persons; an empty result means one of them is not in the graph.
      if (written.length === 0) unresolved.push(`${e.from}→${e.to}`);
      ok++;
      if (ok % 100 === 0) console.log(`  …${ok}/${seeks.length} edges written`);
    } catch (err) {
      failures.push(`${e.from}→${e.to}: ${(err as Error).name}: ${(err as Error).message}`);
    }
  });
  console.log(`dispatched ${ok}/${seeks.length} SEEKS edge(s) through the gate`);

  if (unresolved.length) {
    console.error(
      `SeekTargetMissing: ${unresolved.length} edge(s) matched no Person pair in the graph — ` +
        `run scripts/ingest-guests.ts first. e.g. ${unresolved.slice(0, 5).join(", ")}`,
    );
  }
  if (failures.length) {
    console.error(`FAILURES (${failures.length}):\n${failures.slice(0, 20).join("\n")}`);
  }
  return failures.length || unresolved.length ? 1 : 0;
}

main()
  .then(async (code) => {
    await close();
    process.exit(code);
  })
  .catch(async (e) => {
    if (e instanceof GatewayNotConfigured) {
      console.error("enrich-matches DEGRADED —", e.message);
      await close();
      process.exit(2);
    }
    console.error(`enrich-matches FAILED — ${(e as Error).name}: ${(e as Error).message}`);
    await close();
    process.exit(1);
  });
