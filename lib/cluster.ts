/**
 * lib/cluster.ts — beliefs → embeddings → app-side clusters → ValueCluster nodes.
 *
 * G3 VALUES, with NO Neo4j GDS. Pull every Person's belief from the graph, embed the
 * texts through the Butterbase gateway, agglomerate app-side by cosine similarity
 * (single-linkage union-find), name each cluster via the gateway chat model, and write
 * the result ONLY through the write_value_cluster action (IN_CLUSTER + pairwise
 * SHARES_VALUE edges, each carrying `basis`).
 *
 * Shared surface: lib/gateway.ts —
 *   embed(texts, model?): Promise<number[][]>                       (order-preserving)
 *   chat(model, messages, schema): Promise<T>  — the schema overload gives us the
 *     deterministic JSON guard (parse + zod validate + retry once + fail loud) for free.
 */
import { z } from "zod";
import { embed, chat, DEFAULT_CHAT_MODEL, type ChatMessage } from "@/lib/gateway";
import { run } from "@/lib/neo4j";
import { dispatch } from "@/lib/ontology-gate";

export interface BeliefRow {
  personId: string;
  text: string;
}

export interface ClusterResult {
  clusters: number;
  members: number;
  written: string[];
}

/** Pull one (personId, belief text) per believer, in a stable order. */
export async function fetchBeliefs(): Promise<BeliefRow[]> {
  const { records } = await run(
    `MATCH (p:Person)-[:BELIEVES]->(b:Belief)
     WHERE b.text IS NOT NULL AND b.text <> ''
     RETURN p.id AS personId, b.text AS text
     ORDER BY p.id`,
  );
  return records.map((r) => ({
    personId: String(r.get("personId")),
    text: String(r.get("text")),
  }));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Single-linkage agglomeration via union-find: any pair with cosine >= threshold is
 * merged. Returns groups of indices into the input array. Deterministic.
 */
export function agglomerate(vectors: number[][], threshold: number): number[][] {
  const n = vectors.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosine(vectors[i], vectors[j]) >= threshold) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(i);
    groups.set(root, g);
  }
  return Array.from(groups.values());
}

/** Deterministic guard lives in the gateway: schema overload parses + validates + retries. */
const ClusterNameSchema = z.object({
  name: z.string().min(1),
  basis: z.string().min(1),
});

/** Name a cluster from its member beliefs. Returns {name, basis}; throws loud on gateway failure. */
export async function nameCluster(texts: string[]): Promise<{ name: string; basis: string }> {
  const sample = texts.slice(0, 8).map((t, i) => `${i + 1}. ${t}`).join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You name a cluster of people who share a creative value. Respond with ONLY a JSON " +
        'object of the form {"name": string (2-4 words, Title Case), "basis": string (one ' +
        "sentence naming the shared value)}.",
    },
    { role: "user", content: `Beliefs in this cluster:\n${sample}\n\nName the shared value.` },
  ];
  const out = await chat(DEFAULT_CHAT_MODEL, messages, ClusterNameSchema);
  return { name: out.name.trim().slice(0, 60), basis: out.basis.trim().slice(0, 240) };
}

// ---------------------------------------------------------------------------
// Chat-surface fallback clustering (2026-07-07, live-run deviation): the gateway's
// EMBEDDINGS surface 502'd on all three catalog models mid-hackathon while CHAT stayed
// healthy. Grouping falls back to an LLM-as-clusterer call with a deterministic
// membership guard: the returned groups must PARTITION the belief indexes (every index
// exactly once) and yield >=2 groups of >=2 — otherwise retry once, then fail loud.
// The write path is unchanged: everything still lands through write_value_cluster.
// ---------------------------------------------------------------------------

const ChatGroupsSchema = z.object({
  clusters: z
    .array(
      z.object({
        name: z.string().min(1),
        basis: z.string().min(1),
        memberIndexes: z.array(z.number().int().nonnegative()).min(1),
      }),
    )
    .min(2),
});

/**
 * Deterministic partition REPAIR (rule: code enforces structure, the model only proposes):
 * out-of-range dropped, duplicate indexes keep their first occurrence, missing indexes
 * become singleton clusters. Returns null only if the semantic bar (>=2 clusters with
 * >=2 members) is unreachable after repair.
 */
function repairPartition<T extends { name: string; basis: string; memberIndexes: number[] }>(
  groups: T[],
  n: number,
): T[] | null {
  const seen = new Set<number>();
  const repaired = groups.map((g) => ({
    ...g,
    memberIndexes: g.memberIndexes.filter((idx) => {
      if (idx < 0 || idx >= n || seen.has(idx)) return false;
      seen.add(idx);
      return true;
    }),
  }));
  const missing: number[] = [];
  for (let i = 0; i < n; i++) if (!seen.has(i)) missing.push(i);
  for (const idx of missing) {
    repaired.push({
      name: "Unclustered",
      basis: "No shared value grouping proposed for this belief.",
      memberIndexes: [idx],
    } as T);
  }
  const real = repaired.filter((g) => g.memberIndexes.length > 0);
  return real.filter((g) => g.memberIndexes.length >= 2).length >= 2 ? real : null;
}

export async function chatGroup(
  beliefs: BeliefRow[],
): Promise<{ name: string; basis: string; rows: BeliefRow[] }[]> {
  const listing = beliefs.map((b, i) => `${i}. ${b.text}`).join("\n");
  const base: ChatMessage[] = [
    {
      role: "system",
      content:
        "You cluster short statements of belief about creativity by their SHARED UNDERLYING VALUE. " +
        'Respond with ONLY JSON: {"clusters":[{"name":"2-4 words Title Case","basis":"one sentence ' +
        'naming the shared value","memberIndexes":[ints]}]}. Every index 0..N-1 must appear in EXACTLY ' +
        "one cluster. Aim for 3-6 clusters; a cluster may hold a single outlier, but at least two " +
        "clusters must have two or more members.",
    },
    { role: "user", content: `Beliefs (index. text):\n${listing}\n\nCluster them.` },
  ];
  // Attempt 1 on the default model; attempt 2 on a stronger one. The partition itself is
  // repaired deterministically — only the >=2x2 semantic bar can still fail us.
  const models = [DEFAULT_CHAT_MODEL, process.env.BUTTERBASE_STRONG_MODEL || "openai/gpt-4o"];
  let lastErr = "";
  for (const model of models) {
    try {
      const out = await chat(model, base, ChatGroupsSchema);
      const repaired = repairPartition(out.clusters, beliefs.length);
      if (repaired) {
        return repaired
          .filter((c) => c.memberIndexes.length >= 2)
          .sort((a, b) => b.memberIndexes.length - a.memberIndexes.length)
          .map((c) => ({
            name: c.name.trim().slice(0, 60),
            basis: c.basis.trim().slice(0, 240),
            rows: c.memberIndexes.map((i) => beliefs[i]),
          }));
      }
      lastErr = `model ${model}: repaired partition still lacks 2 clusters of >=2`;
    } catch (e) {
      lastErr = `model ${model}: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`;
    }
  }
  throw new Error(
    `chatGroup: grouping unusable after repair on both models — refusing to write ungrounded clusters (fail-loud). Last: ${lastErr}`,
  );
}

/**
 * Full clustering pass. Reads beliefs, embeds, agglomerates, names, and writes each
 * cluster of >=2 members through the gate. Clusters are ordered largest-first for
 * stable ids (cluster-1, cluster-2, ...). If the embeddings surface is down (gateway
 * 502s), falls back to chat-surface grouping under the partition guard above.
 */
export async function runClustering(opts: { threshold?: number } = {}): Promise<ClusterResult> {
  const threshold = opts.threshold ?? Number(process.env.CLUSTER_THRESHOLD ?? 0.8);
  const beliefs = await fetchBeliefs();
  if (beliefs.length === 0) {
    throw new Error("runClustering: no beliefs found in the graph — run ingest first");
  }

  let named: { name: string; basis: string; rows: BeliefRow[] }[];
  let src = "gateway:embeddings";
  try {
    const vectors = await embed(beliefs.map((b) => b.text));
    if (!Array.isArray(vectors) || vectors.length !== beliefs.length) {
      throw new Error(
        `runClustering: gateway embed() returned ${Array.isArray(vectors) ? vectors.length : "non-array"} vectors for ${beliefs.length} beliefs`,
      );
    }
    const groups = agglomerate(vectors, threshold)
      .filter((g) => g.length >= 2)
      .sort((a, b) => b.length - a.length);
    named = [];
    for (const group of groups) {
      const rows = group.map((idx) => beliefs[idx]);
      const { name, basis } = await nameCluster(rows.map((r) => r.text));
      named.push({ name, basis, rows });
    }
  } catch (err) {
    console.error(
      `cluster: embeddings surface unavailable (${err instanceof Error ? err.message.slice(0, 120) : err}) — falling back to chat-surface grouping (partition-guarded)`,
    );
    named = await chatGroup(beliefs);
    src = "gateway:chat-grouping";
  }

  const written: string[] = [];
  let members = 0;
  for (let i = 0; i < named.length; i++) {
    const { name, basis, rows } = named[i];
    const ids = await dispatch(
      "write_value_cluster",
      {
        cluster: { id: `cluster-${i + 1}`, name, basis },
        members: rows.map((r) => ({ personId: r.personId })),
      },
      { src, actor: "pipeline" },
    );
    written.push(...ids);
    members += rows.length;
  }

  return { clusters: named.length, members, written };
}
