// lib/traverse.ts — TYPED read templates. The agent traverses through these, never freeform.
// Every returned path_receipt is composed of REAL directed edges so scripts/audit-receipts.ts
// can prove each one exists in Neo4j.
//
// INTEGRATION SEAM: the declared shared surface `lib/neo4j.ts` does not yet exist and its API is
// unspecified in the contract SHAPES. To keep this fence self-typechecking and runnable standalone,
// the driver is created here (installed dep `neo4j-driver`, env per the contract). If lib/neo4j.ts
// later exposes a shared read helper, replace getDriver()/runRead() below with it — nothing else changes.

import neo4j, { type Driver } from "neo4j-driver";
import type { ReceiptEdge } from "@/passport/schema";

// ---------------------------------------------------------------------------
// env + driver (fail-loud, degrade cleanly, single lazy singleton)
// ---------------------------------------------------------------------------

let envLoaded = false;
function ensureEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  // Standalone tsx scripts don't auto-load .env (Next does). Best-effort, never throws.
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
  } catch {
    /* .env absent (Next runtime / CI with exported env) — fine, we read process.env below */
  }
}

let driver: Driver | null = null;

export function getDriver(): Driver {
  ensureEnv();
  if (driver) return driver;
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error(
      "[degraded] Neo4j credentials missing — set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD " +
        "(see .env.example). Refusing to run without a database: fail-loud, no silent fallback.",
    );
  }
  driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    disableLosslessIntegers: true, // counts/sizes come back as plain JS numbers
  });
  return driver;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

/** Run a read query and return plain row objects. */
export async function runRead<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const database = process.env.NEO4J_DATABASE || "neo4j";
  const session = getDriver().session({ database });
  try {
    const res = await session.run(cypher, params);
    return res.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export type Candidate = {
  personId: string;
  name: string;
  via: string; // the shared thing (Activity/Company/School/Major/ValueCluster name)
  viaKind: string; // node label of the shared thing, or "ValueCluster"
  basis: string; // short human phrase describing the connection (fed to the why-line prompt)
  path_receipt: ReceiptEdge[]; // real directed edges — audit-verifiable
};

export type Neighborhood = {
  personId: string;
  name: string;
  email: string | null;
  schools: string[];
  majors: string[];
  companies: string[];
  does: string[]; // normalized what-you-do Activity names
  workingOn: string[]; // normalized working-on Activity names
  beliefs: string[]; // raw Belief text
  gradYear: string;
  position: string;
};

export type Standout = {
  personId: string;
  name: string;
  activity: string;
  rel: string; // "DOES" | "WORKING_ON"
  count: number; // how many people share this activity (lower = more distinctive)
};

// ---------------------------------------------------------------------------
// read templates
// ---------------------------------------------------------------------------

/** All people (for batch passport generation). */
export async function allPeople(): Promise<{ id: string; name: string }[]> {
  return runRead<{ id: string; name: string }>(
    `MATCH (p:Person) RETURN p.id AS id, p.name AS name ORDER BY p.name`,
  );
}

/**
 * SAME-WORK path: another guest who shares an Activity (DOES/WORKING_ON) or a Company (WORKS_AT).
 * Receipt = the two real edges into the shared node: (me)->(x) and (other)->(x).
 */
export async function sameWorkPath(personId: string): Promise<Candidate[]> {
  const rows = await runRead<{
    personId: string;
    name: string;
    meName: string;
    rel1: string;
    rel2: string;
    via: string;
    viaKind: string;
  }>(
    `
    MATCH (me:Person {id:$personId})-[r1:DOES|WORKING_ON|WORKS_AT]->(x)<-[r2:DOES|WORKING_ON|WORKS_AT]-(other:Person)
    WHERE other.id <> me.id
    RETURN other.id AS personId, other.name AS name, me.name AS meName,
           type(r1) AS rel1, type(r2) AS rel2, x.name AS via, labels(x)[0] AS viaKind
    ORDER BY via
    `,
    { personId },
  );
  return rows.map((row) => ({
    personId: row.personId,
    name: row.name,
    via: row.via,
    viaKind: row.viaKind,
    basis: `you both connect to ${row.via}`,
    path_receipt: [
      { from: row.meName, rel: row.rel1, to: row.via },
      { from: row.name, rel: row.rel2, to: row.via },
    ],
  }));
}

/**
 * VALUES path: another guest linked by a SHARES_VALUE edge (created app-side by the values agent).
 * Receipt = the single real SHARES_VALUE edge, in its actual stored direction.
 */
export async function valuesPath(personId: string): Promise<Candidate[]> {
  const rows = await runRead<{
    personId: string;
    name: string;
    sFrom: string;
    sTo: string;
    cluster: string | null;
    basis: string | null;
  }>(
    `
    MATCH (me:Person {id:$personId})-[s:SHARES_VALUE]-(other:Person)
    WHERE other.id <> me.id
    RETURN other.id AS personId, other.name AS name,
           startNode(s).name AS sFrom, endNode(s).name AS sTo,
           s.cluster AS cluster, s.basis AS basis
    ORDER BY coalesce(s.basis, s.cluster, '')
    `,
    { personId },
  );
  return rows.map((row) => ({
    personId: row.personId,
    name: row.name,
    via: row.cluster ?? "a shared value",
    viaKind: "ValueCluster",
    basis: row.basis ?? (row.cluster ? `you share the value "${row.cluster}"` : "you share a value"),
    path_receipt: [{ from: row.sFrom, rel: "SHARES_VALUE", to: row.sTo }],
  }));
}

/**
 * FALLBACK context path: a guest who shares a School or Major (both real edges of the SAME type).
 * Used only when same-work / values pools can't fill two distinct finds.
 */
export async function sharedContextPath(personId: string): Promise<Candidate[]> {
  const rows = await runRead<{
    personId: string;
    name: string;
    meName: string;
    rel1: string;
    rel2: string;
    via: string;
    viaKind: string;
  }>(
    `
    MATCH (me:Person {id:$personId})-[r1:STUDIES_AT|MAJORS_IN]->(x)<-[r2:STUDIES_AT|MAJORS_IN]-(other:Person)
    WHERE other.id <> me.id AND type(r1) = type(r2)
    RETURN other.id AS personId, other.name AS name, me.name AS meName,
           type(r1) AS rel1, type(r2) AS rel2, x.name AS via, labels(x)[0] AS viaKind
    ORDER BY via
    `,
    { personId },
  );
  return rows.map((row) => ({
    personId: row.personId,
    name: row.name,
    via: row.via,
    viaKind: row.viaKind,
    basis: `you both connect to ${row.via}`,
    path_receipt: [
      { from: row.meName, rel: row.rel1, to: row.via },
      { from: row.name, rel: row.rel2, to: row.via },
    ],
  }));
}

/** The holder's immediate graph — for line2, gradient hues, and the magic-inference source text. */
export async function personNeighborhood(personId: string): Promise<Neighborhood | null> {
  const rows = await runRead<{
    name: string;
    email: string | null;
    schools: string[];
    majors: string[];
    companies: string[];
    does: string[];
    workingOn: string[];
    beliefs: string[];
    gradYear: string | null;
    position: string | null;
  }>(
    `
    MATCH (me:Person {id:$personId})
    OPTIONAL MATCH (me)-[:STUDIES_AT]->(sch:School)
    OPTIONAL MATCH (me)-[:MAJORS_IN]->(maj:Major)
    OPTIONAL MATCH (me)-[:WORKS_AT]->(co:Company)
    OPTIONAL MATCH (me)-[:DOES]->(da:Activity)
    OPTIONAL MATCH (me)-[:WORKING_ON]->(wa:Activity)
    OPTIONAL MATCH (me)-[:BELIEVES]->(b:Belief)
    RETURN me.name AS name, me.email AS email,
           me.grad_year AS gradYear, me.position AS position,
           collect(DISTINCT sch.name)  AS schools,
           collect(DISTINCT maj.name)  AS majors,
           collect(DISTINCT co.name)   AS companies,
           collect(DISTINCT da.name)   AS does,
           collect(DISTINCT wa.name)   AS workingOn,
           collect(DISTINCT b.text)    AS beliefs
    `,
    { personId },
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const clean = (a: (string | null)[]) => (a ?? []).filter((x): x is string => Boolean(x));
  return {
    personId,
    name: r.name,
    email: r.email ?? null,
    schools: clean(r.schools),
    majors: clean(r.majors),
    companies: clean(r.companies),
    does: clean(r.does),
    workingOn: clean(r.workingOn),
    beliefs: clean(r.beliefs),
    gradYear: r.gradYear ?? "",
    position: r.position ?? "",
  };
}

/**
 * Distinctive working-on / what-you-do lines, ranked by rarity (fewest people first),
 * for hidden-prompt "find the person who…" hunts. Optionally scoped to a party.
 */
export async function standoutFacts(partyId?: string | null): Promise<Standout[]> {
  const scope = partyId ? `WHERE EXISTS { (p)-[:SIGNED_UP]->(:Party {id:$partyId}) }` : ``;
  const rows = await runRead<{
    activity: string;
    rel: string;
    people: { id: string; name: string }[];
    count: number;
  }>(
    `
    MATCH (p:Person)-[r:DOES|WORKING_ON]->(a:Activity)
    ${scope}
    WITH a, type(r) AS rel, collect(DISTINCT { id: p.id, name: p.name }) AS people
    RETURN a.name AS activity, rel AS rel, people AS people, size(people) AS count
    ORDER BY count ASC, activity ASC
    `,
    partyId ? { partyId } : {},
  );
  const out: Standout[] = [];
  for (const row of rows) {
    for (const person of row.people) {
      out.push({
        personId: person.id,
        name: person.name,
        activity: row.activity,
        rel: row.rel,
        count: row.count,
      });
    }
  }
  return out;
}
