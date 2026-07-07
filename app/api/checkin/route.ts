/**
 * app/api/checkin/route.ts — the live kinetic endpoint. POST {personId, partyId?, checkedIn?}.
 *
 * Every write goes through the ontology gate's check_in action — no raw Cypher, provenance
 * stamped {src:'action:check_in', actor:'human'}. Fail loud: no SIGNED_UP edge → 404;
 * missing Neo4j creds → 503 with the named error; anything else → 500 with the message.
 */
import { NextResponse } from "next/server";
import { dispatch } from "@/lib/ontology-gate";
import { DEFAULT_PARTY } from "@/ontology/manifest";
import { Neo4jNotConfigured } from "@/lib/neo4j";

interface CheckinBody {
  personId?: unknown;
  partyId?: unknown;
  checkedIn?: unknown;
}

export async function POST(req: Request) {
  let body: CheckinBody | null;
  try {
    body = (await req.json()) as CheckinBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const personId = body?.personId;
  if (typeof personId !== "string" || !personId.trim()) {
    return NextResponse.json({ ok: false, error: "personId (non-empty string) is required" }, { status: 400 });
  }
  const partyId =
    typeof body?.partyId === "string" && body.partyId.trim() ? body.partyId : DEFAULT_PARTY.id;
  const checkedIn = typeof body?.checkedIn === "boolean" ? body.checkedIn : true;

  try {
    const writtenIds = await dispatch(
      "check_in",
      { personId, partyId, checkedIn },
      { src: "action:check_in", actor: "human" },
    );
    if (writtenIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: `no SIGNED_UP edge for person "${personId}" at party "${partyId}"` },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, personId, partyId, checkedIn, writtenIds });
  } catch (e) {
    if (e instanceof Neo4jNotConfigured) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
