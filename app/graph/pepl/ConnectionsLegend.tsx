"use client";

/* Connections — the room's thread legend, and on selection the focused
   person's EGO-STATS panel. Square corners, sentence case, film hues. Lifted
   out of PeplGraph so it is a component the pill row can mount and unmount
   like the ticker and the map. Hiding the box never touches `edgeOn` — the
   threads it last set keep drawing.

   THE DIVISION OF LABOR (Addendum 6). Named ties belong to the threads
   widget: it already carries the full ranked list with receipts, so this box
   never repeats them. What it answers instead is "who is this person, and how
   many people share each trait" — traditional knowledge-graph ego stats, the
   reading that makes "how everyone is connected to each other" legible.

   TWO SOURCES, ONE SWITCH. `focusKey` is the only mode signal: null and the
   ROOM speaks (every tie in the bake, counted by type, each row a toggle that
   floods the room with that thread type); set and THIS PERSON speaks — same
   box, their stats. The toggles are a property of the ROOM, so they ride with
   the room: while someone is focused the room is veiled and their own threads
   draw regardless, which is exactly when a thread-type switch has nothing
   left to say. Deselect and the four toggles are back, untouched.

   THE FOUR ROWS, and where each number comes from. All of them are computed
   HERE, at select time, out of the already-SEEDED room — `GUEST_DETAILS`
   (graph.json node fields) and `ROOM_EDGES` (graph.json edges) — so the panel
   is whole the moment a dot is picked and nothing waits on a fetch. Cohort
   sizes are counted over NODE FIELDS, never over edges: the school/company/why
   edges are a sampled ring and a person record's edge list is ranked and
   capped (8 toward-you + 12 other), so either would silently under-report.
     1. WHERE FROM — their school and company cohorts ("Temple University ·
        1 of 2"). A cohort of ONE is not a room to be one of: it is skipped
        here and speaks in row 4 instead, as rarity. Freelancers get the
        freelance cohort and never a company line. If both fall through, the
        craft rung carries the row — `asp` is present for 304 of the 312 and
        has no singleton, so it never degenerates.
     2. SHARES A CONVICTION — distinct OTHER guests holding at least one of
        their four conviction tags (motive · mission · impact · aspiration).
        Absent for the 5 guests who hold none; it never renders "0 people".
     3. LOOKING FOR THEM — inbound seek edges deduped by partner (mutual pairs
        are baked both ways, so a pair counts once), with a "both ways" line
        added when the pull is mutual. GATED on the person having actually
        written a goal / drew / seeking answer: one blank profile is the
        room's most-sought guest purely as a TF-IDF fallback artifact, and a
        stat that nobody's own words support is not a stat.
     4. RARITY — their least-common trait pairing, motive x aspiration ONLY,
        and only while it is genuinely rare (a pair held by 1, or by 2-3).
        Mission/impact are deliberately conservative — a null there means the
        enricher declined, not that the trait is rare — so a "the only one"
        cut through them would be falsifiable. The ladder then falls to a
        single-trait cohort of one, then to a craft held by no more than
        RARE_SOLO_MAX. Above that ceiling THE ROW IS SILENT: this is the one
        row that speaks in the rarity register, so it may never carry a common
        fact — "1 of 48 aiming to direct" is a membership fact, and membership
        is row 1's job, not this one's. Hometown is excluded entirely until
        metros are normalized.

   NOTHING RENDERS AS A ZERO, a "1 of 1", or a placeholder. A row whose fact
   is missing is simply not there — absence reads as absence (laws c/d). One
   guest (the ghost profile: no school, no company, no tags, no answers) gets
   no stat rows at all, and that is the honest reading of what we know.

   Every field above is baked by scripts/emit-graph.ts, and a human corrects
   it at ONE station: data/graph-overrides.csv (the conviction tags, or `hide`
   to drop someone) plus a re-run of the emit — never by hand-editing
   public/graph/*. Section D's data reconciliation VERIFIES these numbers
   against the baked `highlights[]` in the person records — the sought-by
   counts agree for all 242 guests who carry one — but it is a CHECK on this
   panel, not its source; the panel stays derivable from the seeded room. */

import type { CSSProperties } from "react";
import { GUEST_DETAILS, ROOM_EDGES, type RoomEdgeType } from "./adapter";

const ROWS: { type: RoomEdgeType; label: string; hue: string }[] = [
  { type: "why", label: "Shared conviction", hue: "var(--film-violet)" },
  { type: "seek", label: "Seeking match", hue: "var(--film-magenta)" },
  { type: "school", label: "Same school", hue: "var(--film-blue)" },
  { type: "company", label: "Same company", hue: "var(--film-gold)" },
];

/* How many threads of each type the room holds — fixed for the session, since
   PartyScene seeds ROOM_EDGES before it imports the scene. One pass here, not
   four filters over every edge on every render. */
const COUNT: Partial<Record<RoomEdgeType, number>> = {};
for (const e of ROOM_EDGES) COUNT[e.type] = (COUNT[e.type] ?? 0) + 1;

/** a pair cohort this size or smaller is worth calling rare; above it the line
    would be dressing a common fact up as an uncommon one */
const RARE_MAX = 3;

/** The ceiling on the ladder's LAST rung, a lone craft. A pair is two traits at
    once, so RARE_MAX can be tighter there; one trait has to be small on its own
    account. Unbounded, this rung shipped "direct · 1 of 48" — the venue's
    LARGEST craft cohort — in the row whose entire law is that it only speaks
    when the fact is rare (87 of 312 guests got one). On the current bake
    nothing reaches it at all: every guest whose craft is this uncommon is
    already caught by the pair or single-trait rungs above, so row 4 now falls
    silent for those 87 rather than padding. The rung survives for a population
    where a rare craft is somebody's ONLY rare trait. */
const RARE_SOLO_MAX = 5;

/** A cohort of one has no corroboration that the string even NAMES a shared
    place — two people writing "USC" prove USC is a room, one person writing
    "Compass Real Estate (not exactly related to what I'm interested in
    pursuing in my future)" proves nothing. So the single-trait rarity rung
    only speaks for answers shaped like a name: short, and free of the
    parentheses and slashes that mark a sentence. Same conservatism that keeps
    hometown out of rarity until metros are normalized. Row 1 needs no such
    guard — a cohort of more than one IS the corroboration. */
const NAME_MAX = 32;
const namelike = (s: string): boolean => s.length <= NAME_MAX && !/[()/]/.test(s);

/** Cohorts are counted case- and whitespace-insensitively: the guest list holds
    "ASU"/"asu" and "Netflix"/"netflix", and counting those apart would hand
    three people a FALSE "the only one". The person's own spelling is what
    renders — the COUNT is normalized, never their answer. */
const ckey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** the four conviction tags, as `GUEST_DETAILS` names them (motive is `group`,
    aspiration is `craft`) — row 2 is pinned to exactly this union */
const TAG_FIELDS = ["group", "mission", "impact", "craft"] as const;

type Tables = {
  school: Map<string, number>;
  company: Map<string, number>;
  craft: Map<string, number>;
  /** motive x aspiration — the only pairing rarity is ever cut from */
  pair: Map<string, number>;
  free: number;
  /** personId → how many OTHER guests share at least one conviction tag */
  reach: Map<string, number>;
  /** personId → the distinct people seeking them */
  inbound: Map<string, Set<string>>;
  /** personId → the distinct people they and the other are seeking mutually */
  mutual: Map<string, Set<string>>;
};

/* One pass over the seeded room, memoized on the seed itself so a Fast Refresh
   reseed (adapter.seedScene swaps these objects) recomputes instead of serving
   the previous room's counts. */
let cache: Tables | null = null;
let cachedFor: unknown = null;

function tables(): Tables {
  if (cache && cachedFor === GUEST_DETAILS) return cache;
  const t: Tables = {
    school: new Map(),
    company: new Map(),
    craft: new Map(),
    pair: new Map(),
    free: 0,
    reach: new Map(),
    inbound: new Map(),
    mutual: new Map(),
  };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  /** "field:value" → everyone holding that exact conviction tag */
  const holders = new Map<string, string[]>();

  for (const [id, d] of Object.entries(GUEST_DETAILS)) {
    const school = (d.school ?? "").trim();
    const company = (d.company ?? "").trim();
    const craft = (d.craft ?? "").trim();
    const group = (d.group ?? "").trim();
    if (school) bump(t.school, ckey(school));
    if (company) bump(t.company, ckey(company));
    if (craft) bump(t.craft, ckey(craft));
    if (group && craft) bump(t.pair, `${ckey(group)}|${ckey(craft)}`);
    if (d.free === true) t.free += 1;
    for (const f of TAG_FIELDS) {
      const v = (d[f] ?? "").trim();
      if (!v) continue;
      const k = `${f}:${ckey(v)}`;
      const list = holders.get(k);
      if (list) list.push(id);
      else holders.set(k, [id]);
    }
  }

  for (const [id, d] of Object.entries(GUEST_DETAILS)) {
    const others = new Set<string>();
    for (const f of TAG_FIELDS) {
      const v = (d[f] ?? "").trim();
      if (!v) continue;
      for (const o of holders.get(`${f}:${ckey(v)}`) ?? []) if (o !== id) others.add(o);
    }
    /* no tags → no entry at all, so row 2 renders as absent, never as zero */
    if (others.size > 0) t.reach.set(id, others.size);
  }

  const add = (m: Map<string, Set<string>>, id: string, other: string) => {
    const s = m.get(id);
    if (s) s.add(other);
    else m.set(id, new Set([other]));
  };
  for (const e of ROOM_EDGES) {
    if (e.type !== "seek") continue;
    /* the emitter writes seek as from → to, so `t` is the one being sought */
    add(t.inbound, e.t, e.s);
    if (e.m) {
      add(t.mutual, e.t, e.s);
      add(t.mutual, e.s, e.t);
    }
  }
  cachedFor = GUEST_DETAILS;
  cache = t;
  return t;
}

/** one rendered stat: a trait on the left, how many people share it on the right */
type EgoRow = { k: string; label: string; value: string };

const people = (n: number): string => `${n} ${n === 1 ? "person" : "people"}`;

/** The four rows, in speaking order. Every branch is a fact or it is nothing. */
function egoRows(id: string, answered: boolean): EgoRow[] {
  const d = GUEST_DETAILS[id];
  if (!d) return [];
  const t = tables();
  const rows: EgoRow[] = [];
  const school = (d.school ?? "").trim();
  const company = (d.company ?? "").trim();
  const craft = (d.craft ?? "").trim();
  const group = (d.group ?? "").trim();
  const schoolN = school ? t.school.get(ckey(school)) ?? 0 : 0;
  const companyN = company ? t.company.get(ckey(company)) ?? 0 : 0;
  const craftN = craft ? t.craft.get(ckey(craft)) ?? 0 : 0;

  /* 1 — where from. Their own spelling, the room's count. */
  if (schoolN > 1) rows.push({ k: "school", label: school, value: `1 of ${schoolN}` });
  if (d.free === true) rows.push({ k: "free", label: "Freelance", value: `1 of ${t.free}` });
  else if (companyN > 1) rows.push({ k: "company", label: company, value: `1 of ${companyN}` });
  /* the fallback rung — only when nothing above spoke, so it never doubles up */
  const craftRung = rows.length === 0 && craftN > 1;
  if (craftRung) rows.push({ k: "craft", label: craft, value: `1 of ${craftN}` });

  /* 2 — conviction reach, over the four-tag union */
  const reach = t.reach.get(id) ?? 0;
  if (reach > 0) rows.push({ k: "reach", label: "Shares a conviction", value: people(reach) });

  /* 3 — seek gravity, gated on their own words existing */
  if (answered) {
    const inbound = t.inbound.get(id)?.size ?? 0;
    const mutual = t.mutual.get(id)?.size ?? 0;
    if (inbound > 0) rows.push({ k: "seek", label: "Looking for them", value: people(inbound) });
    if (mutual > 0) rows.push({ k: "mutual", label: "Both ways", value: people(mutual) });
  }

  /* 4 — rarity: motive x aspiration first, then the single-trait rungs */
  const pairN = group && craft ? t.pair.get(`${ckey(group)}|${ckey(craft)}`) ?? 0 : 0;
  const pairLabel = `${group} · ${craft}`;
  if (pairN === 1) rows.push({ k: "rare", label: pairLabel, value: "the only one" });
  else if (pairN > 1 && pairN <= RARE_MAX) rows.push({ k: "rare", label: pairLabel, value: `1 of ${pairN}` });
  else if (schoolN === 1 && namelike(school)) rows.push({ k: "rare", label: school, value: "the only one" });
  else if (companyN === 1 && d.free !== true && namelike(company))
    rows.push({ k: "rare", label: company, value: "the only one" });
  /* the last rung, and the only one that can reach a big cohort — so it is the
     only one that needs a ceiling. `!craftRung` keeps it from repeating the
     craft line row 1 already spent on this person. */
  else if (!craftRung && craftN > 1 && craftN <= RARE_SOLO_MAX)
    rows.push({ k: "rare", label: craft, value: `1 of ${craftN}` });

  return rows;
}

export default function ConnectionsLegend({
  edgeOn,
  onToggle,
  bottom,
  ui,
  focusKey,
  focusAnswered,
  nameOf,
}: {
  edgeOn: Record<RoomEdgeType, boolean>;
  onToggle: (type: RoomEdgeType) => void;
  /** rides above the pill row (and the ticker, when it is up) */
  bottom: number;
  /** the scene's type token — the legend never invents its own */
  ui: CSSProperties;
  /** the selected person, or null for the room. THE mode signal. */
  focusKey: string | null;
  /** their record carries at least one of goal / drew / seeking — the ONE fact
      this panel cannot read off the seeded room, so the scene hands it over.
      False while the record is in flight, which holds the seek row back rather
      than showing a number their own words do not support. */
  focusAnswered: boolean;
  /** the scene's own id → display name resolver */
  nameOf: (id: string) => string;
}) {
  /* their per-type counts, from the complete tie set. Mutual seeks are baked
     as two directed edges — key by partner+type so one tie counts once,
     exactly as their record lists it once. */
  const countTies = (id: string): Record<RoomEdgeType, number> => {
    const n: Record<RoomEdgeType, number> = { why: 0, seek: 0, school: 0, company: 0 };
    const seen = new Set<string>();
    for (const e of ROOM_EDGES) {
      const other = e.s === id ? e.t : e.t === id ? e.s : "";
      if (!other || seen.has(`${e.type}:${other}`)) continue;
      seen.add(`${e.type}:${other}`);
      n[e.type] += 1;
    }
    return n;
  };
  const ties = focusKey ? countTies(focusKey) : null;
  const total = ties ? ties.why + ties.seek + ties.school + ties.company : 0;
  const stats = focusKey ? egoRows(focusKey, focusAnswered) : [];
  /* the section hairline the threads widget speaks in */
  const header: CSSProperties = {
    ...ui,
    textTransform: "none",
    fontSize: 9,
    letterSpacing: "0.05em",
    color: "rgba(26,25,24,0.36)",
    paddingBottom: 3,
    borderBottom: "1px solid rgba(38,36,44,0.05)",
    marginBottom: 3,
  };
  return (
    <div
      style={{
        position: "absolute",
        left: 20,
        bottom,
        width: 184,
        padding: "10px 14px 12px",
        borderRadius: 0,
        background: "rgba(255,253,251,0.78)",
        backdropFilter: "blur(12px)",
        boxShadow:
          "inset 0 0 0 1px rgba(255,255,255,0.55), 0 0 0 1px rgba(38,36,44,0.045)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-hedvig), Georgia, serif",
          fontSize: 15,
          letterSpacing: "0.01em",
          color: "rgba(38,36,44,0.6)",
          marginBottom: focusKey ? 4 : 7,
        }}
      >
        connections
      </div>
      {/* re-keyed on the mode signal so the whole readout rises on the flip
          and again on the way back — the room's own entrance grammar, and
          the reduced-motion rule that stills it is already written */}
      <div className="pepl-group" key={focusKey ?? "room"}>
        {focusKey && (
          <div style={{ ...header, display: "flex", gap: 6, alignItems: "baseline" }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                /* the name as they wrote it — capitalize only lifts the
                   all-lowercase ids, it never flattens a MacIlvaine */
                textTransform: "capitalize",
                color: "rgba(26,25,24,0.6)",
                fontSize: 10.5,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {nameOf(focusKey)}
            </span>
            <span style={{ fontSize: 8.5, color: "rgba(26,25,24,0.32)" }}>
              {total === 1 ? "1 tie" : `${total} ties`}
            </span>
          </div>
        )}
        {/* ROOM MODE — the toggles are the room's own control, and they are
            back the moment the selection is dropped */}
        {!focusKey &&
          ROWS.map((row) => {
            const on = edgeOn[row.type];
            const n = COUNT[row.type] ?? 0;
            return (
              <button
                key={row.type}
                className="pepl-item"
                onClick={() => onToggle(row.type)}
                aria-pressed={on}
                aria-label={`${row.label} — ${n} in the room, toggle these threads across the room`}
                style={{
                  ...ui,
                  textTransform: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "4px 4px",
                  border: "none",
                  borderRadius: 0,
                  background: "transparent",
                  color: on ? "rgba(26,25,24,0.72)" : "rgba(26,25,24,0.34)",
                  fontSize: 10.5,
                  letterSpacing: "0.02em",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 2,
                    background: row.hue,
                    opacity: on ? 0.95 : 0.3,
                    flex: "none",
                  }}
                />
                <span style={{ flex: 1, whiteSpace: "nowrap" }}>{row.label}</span>
                <span style={{ fontSize: 8.5, color: "rgba(26,25,24,0.32)" }}>{n}</span>
              </button>
            );
          })}
        {/* PERSON MODE — the ego stats. Not buttons: nothing here toggles, so
            nothing here wears a hover state that promises it does. */}
        {stats.map((s) => (
          <div
            key={s.k}
            style={{
              ...ui,
              textTransform: "none",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 6,
              padding: "2px 4px",
              fontSize: 10.5,
              letterSpacing: "0.015em",
              color: "rgba(26,25,24,0.62)",
            }}
          >
            <span
              title={s.label}
              style={{
                minWidth: 0,
                /* no capitalize: a school and a company are THEIR answer,
                   verbatim, and the conviction tags are lowercase by design */
                /* WRAPS, never clips. The label IS the claim — a rarity row
                   reading "representation … · the only one" has lost the thing
                   it is claiming. Two lines is the worst case: the widest
                   cohort name in the bake is 25 characters and the rarity
                   rungs are capped at NAME_MAX. */
                overflowWrap: "anywhere",
              }}
            >
              {s.label}
            </span>
            <span
              style={{
                flex: "none",
                fontSize: 8.5,
                color: "rgba(26,25,24,0.42)",
                whiteSpace: "nowrap",
              }}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
