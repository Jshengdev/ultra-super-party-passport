"use client";

/* The RSVP detail burst: up to three passport stamps pop out around a
   person's dot (top left · middle · right), each carrying their
   details, then peel off when the person is released.

   nametag (blue)  — where the day goes: school small, company large
   belief (card)   — craft word, conviction, signed name
   round (oval)    — hometown centre, the party around the ring, title below

   A STAMP MAY ONLY SAY WHAT THE GUEST SAID. Every value below comes off the
   baked graph.json node (audited byte-for-byte against the CSV by
   scripts/audit-graph.ts); a field the guest left blank leaves its slot blank,
   and a stamp with no true fact left in it is not rendered at all. Three
   stamps is the maximum, never the quota — the old
   "somewhere / freelance / creative / planet earth / @offline / no comment"
   fillers printed invented copy on the one surface in this product whose whole
   job is to be a verified fact (CLAUDE.md laws c + d, audit-graph obligation 3:
   absence renders as absence). */

import { useMemo } from "react";
import { NAMETAG_SVG, BELIEF_STAMP_SVG, ROUND_STAMP_SVG } from "./stamps/assets";
import { injectSvg, withRootAttrs } from "./stamps/injectSvg";
import type { GuestDetails } from "./adapter";

export type StampData = {
  personKey: string;
  name: string;
  details: Partial<GuestDetails>;
};

/* layout around the anchor (the dot), in px: top left · middle · right.
   aspect keeps each wrapper at its SVG's natural proportions. Offsets are
   deliberately TIGHT — the burst should crowd the person's name, not orbit
   it. (PeplGraph's on-screen clamps mirror these extents; change both.) */
const SLOTS = [
  { left: -218, top: -118, width: 172, aspect: "274 / 147", rot: -8, fromX: 200, fromY: 120, oval: false },
  { left: -70, top: -158, width: 166, aspect: "266 / 164", rot: 3, fromX: 0, fromY: 170, oval: false },
  { left: 64, top: -146, width: 150, aspect: "250 / 151", rot: 10, fromX: -180, fromY: 150, oval: true },
];

const firstWord = (s: string) => (s.split(/\s+/)[0] ?? "").toLowerCase();

/* The ring is the ISSUER, not the person: the one line in the burst that is a
   fact about the night rather than a claim about the guest — exactly what the
   country ring on a real passport stamp is. It replaces the handle ring, which
   printed "@offline" on all 312 people: no Instagram handle exists in any
   emitted artifact, and none can, because graph.json fails its own PII gate on
   a bare "@" (scripts/check-graph-emit.ts).

   Length is measured, not guessed: the ring path is 500.5 units long
   (getTotalLength), and this string renders 441 at 20px / 1.5 tracking in the
   room's Plus Jakarta Sans — a full ring with air at the seam. The old tiling
   helper padded to ≥42 characters and sliced at 64, which overran the path and
   lapped the text over itself on any handle worth reading. */
const RING = "·   LA INTERN PARTY   ·   LA INTERN PARTY   ·";

/** Real answers run long — an 80-character company cell squeezed into the
    nametag's 230px slot is compressed past reading. Cut with an ellipsis, which
    says "there is more of this" instead of quietly rewriting it. */
const clamp = (v: string, max: number) => (v.length > max ? v.slice(0, max - 1).trimEnd() + "…" : v);

/** A hometown as a place, not as a paragraph. Guests answered that box with
    "Hanoi, Vietnam (Rochester, NY)" and "Riverside, CA / Las Vegas, NV", and the
    oval's centre line is 190px wide — so the FIRST place they named is what
    goes on the stamp. Still their own word, nothing added; if even that will not
    fit, the hometown is dropped rather than squeezed into an unreadable line. */
function place(raw: string) {
  const first = (raw.split(/[,/(]/)[0] ?? "").trim();
  return first.length > 0 && first.length <= 24 ? first : "";
}

/** Their name as they wrote it. pepl lowercased the signature, which reads as
    style right up until it hits "BJ" or "MacIlvaine" — so interior capitals are
    kept verbatim, and only a name that arrives uniformly cased (all lower, or
    SHOUTING) is re-cased to Title Case. A lone short token is initials, not a
    shout, and is left alone: the same acronym guard passport/textCase.ts uses,
    kept local because that helper sentence-cases positions, not names. */
function personName(raw: string): string {
  const n = raw.trim();
  if (!n) return "";
  const uniform = n === n.toLowerCase() || n === n.toUpperCase();
  if (!uniform) return n; // "Aidan MacIlvaine", "BJ Smith"
  if (!/\s/.test(n) && n.length <= 3) return n; // "BJ"
  return n.replace(/[\p{L}\p{M}']+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** One stamp's injected values, or null when the person gave us nothing that
    stamp could truthfully carry. Index = its slot in SLOTS. */
type StampFill = Record<string, string> | null;

/**
 * What the three stamps are allowed to say, in the order each slot prefers.
 *
 * THE LADDERS (every rung is a real graph.json field; the stamp is dropped when
 * the ladder runs out):
 *   nametag  company → freelance flag → school → title      (small line: school, else title)
 *   belief   motive → craft → mission → impact              (always signed with their name)
 *   round    hometown centre, title (else craft) below       (ring: the party)
 *
 * Nothing is printed twice in one burst: the first stamp to claim a value owns
 * it, and later slots fall to their next real rung instead of echoing it.
 */
export function compose(data: StampData): [StampFill, StampFill, StampFill] {
  const d = data.details;
  const t = (v: string | undefined) => (v ?? "").trim();
  const school = t(d.school);
  const company = t(d.company);
  const title = t(d.title);
  const group = t(d.group);
  const craft = t(d.craft);
  const mission = t(d.mission);
  const impact = t(d.impact);
  const hometown = place(t(d.hometown));

  const used = new Set<string>();
  const claim = (v: string) => {
    const k = v.toLowerCase();
    if (!v || used.has(k)) return "";
    used.add(k);
    return v;
  };

  /* 1 · the nametag — where the day actually goes. "Freelance" is the `free`
     flag, a fact the guest stated by answering the company question with the
     form's own freelance word; it is never inferred from an empty cell. */
  let nametag: StampFill = null;
  // the small line is the school and only the school: their role belongs on the round
  // stamp, and a role stacked over an employer it may have nothing to do with is a
  // claim we cannot make. Lazy, so the school is not claimed by a branch that never runs.
  const org = () => clamp(claim(school), 40);
  if (company) nametag = { headerLabel: "THE DAY JOB", org: org(), name: clamp(claim(company), 36) };
  else if (d.free) nametag = { headerLabel: "THE DAY JOB", org: org(), name: "Freelance" };
  // no employer at all: the header follows the fact it is standing over
  else if (school) nametag = { headerLabel: "THE SCHOOL", org: "", name: clamp(claim(school), 36) };
  else if (title) nametag = { headerLabel: "THE DAY JOB", org: "", name: clamp(claim(title), 36) };

  /* 2 · the belief card — their conviction, signed. The card survives an empty
     conviction because the signature on it is real; what dies is the old
     "no comment", which put words in the mouth of someone who never spoke. */
  const belief = claim(group) || claim(craft) || claim(mission) || claim(impact);
  const small = group && craft ? claim(craft) : firstWord(title);
  const signature = personName(data.name);
  const card: StampFill =
    signature || belief || small
      ? { small, belief: belief.length > 48 ? belief.slice(0, 46) + "…" : belief, name: signature }
      : null;

  /* 3 · the round stamp — where they came from, over what they do. */
  const relation = claim(hometown);
  const roundName = claim(title) || claim(craft);
  const round: StampFill =
    relation || roundName
      ? { relation, ringText: RING, name: clamp(roundName.toLowerCase(), 36) }
      : null;

  return [nametag, card, round];
}

export default function StampBurst({ data, on }: { data: StampData; on: boolean }) {
  const stamps = useMemo(() => {
    const [nametag, card, round] = compose(data);
    const art = [NAMETAG_SVG, BELIEF_STAMP_SVG, ROUND_STAMP_SVG];
    try {
      return [nametag, card, round].flatMap((values, slot) =>
        values
          ? [{ slot, svg: withRootAttrs(injectSvg(art[slot], values), { width: "100%", height: "100%" }) }]
          : [],
      );
    } catch (e) {
      console.error("[stamps]", e);
      return null;
    }
  }, [data]);

  if (!stamps || stamps.length === 0) return null;

  return (
    <div aria-hidden style={{ position: "absolute", top: 0, left: 0 }}>
      <style>{`
        .pepl-stamp {
          position: absolute;
          pointer-events: none;
          will-change: transform, opacity;
          filter: none;
          /* base rotation so reduced-motion users still get the
             composed -8/3/10deg tilt; keyframes override it */
          transform: rotate(var(--rot));
        }
        .pepl-stamp.in {
          animation: stampIn 480ms cubic-bezier(0.16, 1, 0.3, 1) both;
          animation-delay: calc(var(--i) * 85ms);
        }
        .pepl-stamp.out {
          animation: stampPeel 320ms cubic-bezier(0.45, 0, 0.85, 0.55) both;
          animation-delay: calc(var(--i) * 45ms);
        }
        @keyframes stampIn {
          0% {
            opacity: 0;
            transform: translate(var(--fromX), var(--fromY))
              rotate(calc(var(--rot) - 17deg)) scale(0.18);
          }
          72% {
            opacity: 1;
            transform: translate(0px, 0px) rotate(calc(var(--rot) + 2.5deg)) scale(1.06);
          }
          100% {
            opacity: 1;
            transform: translate(0px, 0px) rotate(var(--rot)) scale(1);
          }
        }
        @keyframes stampPeel {
          0% {
            opacity: 1;
            transform: rotate(var(--rot)) scale(1);
          }
          100% {
            opacity: 0;
            transform: translate(8px, -30px) rotate(calc(var(--rot) - 15deg))
              scale(0.82) skewX(-5deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .pepl-stamp.in, .pepl-stamp.out { animation: none; }
          .pepl-stamp.out { opacity: 0; }
        }
      `}</style>
      {/* a dropped stamp leaves its slot empty — the surviving stamps keep their
          own geometry, tilt and stagger, so a two-stamp burst is her burst with
          one fewer card in it, not a re-flowed one */}
      {stamps.map(({ slot: i, svg }) => {
        const slot = SLOTS[i];
        return (
          <div
            key={`${data.personKey}-${i}`}
            className={`pepl-stamp ${on ? "in" : "out"}`}
            style={
              {
                left: slot.left,
                top: slot.top,
                width: slot.width,
                aspectRatio: slot.aspect,
                transformOrigin: "30% 100%",
                /* cream backing: the room must not read THROUGH a stamp */
                background: "var(--cream)",
                borderRadius: slot.oval ? "50%" : 6,
                "--i": i,
                "--rot": `${slot.rot}deg`,
                "--fromX": `${slot.fromX}px`,
                "--fromY": `${slot.fromY}px`,
              } as React.CSSProperties
            }
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        );
      })}
    </div>
  );
}
