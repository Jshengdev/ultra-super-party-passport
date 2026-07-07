/**
 * lib/ontology-gate.ts — THE ONLY WRITE PATH into the graph.
 *
 * dispatch(actionName, params, provenance):
 *   1. resolves the action in the manifest        → unknown action throws OffOntologyWrite
 *   2. asserts every label/pattern the action      → any off-ontology write throws
 *      declares is on the manifest allowlist          OffOntologyWrite (belt + suspenders:
 *                                                      even a mis-declared action can't run)
 *   3. validates params against the action's zod   → invalid params throw ActionValidationError
 *   4. injects provenance {_src,_ts,_actor}        → grounding-by-construction
 *   5. runs the parameterized Cypher, returns the written ids
 *
 * There is no raw-write escape hatch. If a label or relationship type is not in
 * ontology/manifest.ts, it is unrepresentable in the database.
 */
import {
  ACTIONS,
  isAllowedLabel,
  isAllowedPattern,
  type ActionName,
  type Actor,
} from "@/ontology/manifest";
import { run, toNum } from "@/lib/neo4j";

export class OffOntologyWrite extends Error {
  constructor(message: string) {
    super(`OffOntologyWrite: ${message}`);
    this.name = "OffOntologyWrite";
  }
}

export class ActionValidationError extends Error {
  constructor(message: string) {
    super(`ActionValidationError: ${message}`);
    this.name = "ActionValidationError";
  }
}

export interface Provenance {
  src?: string;
  actor?: Actor;
}

/**
 * Execute a manifest-declared ACTION. Returns the ids the Cypher reported in its
 * `writtenIds` column (empty array if the write matched nothing).
 */
export async function dispatch(
  actionName: string,
  params: unknown,
  provenance: Provenance = {},
): Promise<string[]> {
  const action = ACTIONS[actionName as ActionName];
  if (!action) {
    throw new OffOntologyWrite(`unknown action "${actionName}" — not in the manifest registry`);
  }

  // (2) structural allowlist — the action's own declaration must stay on-ontology.
  for (const label of action.writesLabels) {
    if (!isAllowedLabel(label)) {
      throw new OffOntologyWrite(`action "${actionName}" declares off-ontology label "${label}"`);
    }
  }
  for (const [from, rel, to] of action.writesPatterns) {
    if (!isAllowedPattern(from, rel, to)) {
      throw new OffOntologyWrite(
        `action "${actionName}" declares off-ontology pattern (${from})-[:${rel}]->(${to})`,
      );
    }
  }

  // (3) param validation.
  const parsed = action.params.safeParse(params);
  if (!parsed.success) {
    throw new ActionValidationError(`${actionName}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
  }

  // (4) provenance injection — callers cannot spoof these into business params because
  // the underscore-prefixed keys live only here.
  const enriched: Record<string, unknown> = {
    ...(parsed.data as Record<string, unknown>),
    _src: provenance.src ?? action.defaultSrc,
    _ts: new Date().toISOString(),
    _actor: provenance.actor ?? action.defaultActor,
  };

  // (5) execute.
  const { records } = await run(action.cypher, enriched);
  if (records.length === 0) return [];
  const first = records[0];
  if (first.has("writtenIds")) {
    const raw = first.get("writtenIds");
    if (Array.isArray(raw)) return raw.map((x) => String(x));
  }
  // Fallback: collect any per-row `id` column.
  return records.filter((r) => r.has("id")).map((r) => String(r.get("id")));
}

/** re-exported so callers can `catch` on identity if they prefer. */
export { toNum };
