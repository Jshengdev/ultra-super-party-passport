/**
 * lib/neo4j.ts — the driver singleton + the one `run()` all Cypher goes through.
 *
 * Fail-loud law: with no creds we throw a NAMED error (Neo4jNotConfigured) that lists
 * exactly which env vars are missing — never a silent no-op. Callers in DEGRADED mode
 * catch it, print it, and exit 2. Reads/writes both go through driver.executeQuery,
 * which is neo4j+s:// (Aura) aware and manages routing internally.
 */
import neo4j, { type Driver, type Record as Neo4jRecord } from "neo4j-driver";

export class Neo4jNotConfigured extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Neo4jNotConfigured: missing env [${missing.join(", ")}]. ` +
        `Set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD (and optionally NEO4J_DATABASE).`,
    );
    this.name = "Neo4jNotConfigured";
    this.missing = missing;
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.NEO4J_URI && process.env.NEO4J_USERNAME && process.env.NEO4J_PASSWORD);
}

export function database(): string {
  return process.env.NEO4J_DATABASE || "neo4j";
}

function requireConfig() {
  const uri = process.env.NEO4J_URI;
  const username = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  const missing: string[] = [];
  if (!uri) missing.push("NEO4J_URI");
  if (!username) missing.push("NEO4J_USERNAME");
  if (!password) missing.push("NEO4J_PASSWORD");
  if (missing.length) throw new Neo4jNotConfigured(missing);
  return { uri: uri as string, username: username as string, password: password as string };
}

let _driver: Driver | null = null;

export function getDriver(): Driver {
  if (_driver) return _driver;
  const { uri, username, password } = requireConfig();
  _driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  return _driver;
}

export interface RunResult {
  records: Neo4jRecord[];
}

/** Run parameterized Cypher. Throws Neo4jNotConfigured if creds are absent. */
export async function run(
  query: string,
  params: Record<string, unknown> = {},
): Promise<RunResult> {
  const driver = getDriver();
  const { records } = await driver.executeQuery(query, params, { database: database() });
  return { records };
}

export async function close(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}

/** neo4j Integers come back as {low,high} objects — coerce to a JS number safely. */
export function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (neo4j.isInt(v)) return (v as unknown as { toNumber(): number }).toNumber();
  const maybe = v as { toNumber?: () => number };
  if (typeof maybe.toNumber === "function") return maybe.toNumber();
  return Number(v);
}
