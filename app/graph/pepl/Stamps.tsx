"use client";

/* THE THREE IDENTITY CARDS: who we think this person is, summed up, popped out
   around their dot (top left · middle · right) and peeled off when they are
   released.

     CARD 1 · WHO THEY ARE           the belief square, middle — the hero slot.
                                     their motive, their own words, signed.
     CARD 2 · WHAT THEY VALUE        the oval, right. their mission (else
                                     impact), over the facts they filled in.
     CARD 3 · WHAT THEY'RE WORKING   the blue nametag, left. their craft, and
              TOWARD                 their answer to what they want to do.

   THE THREE-REGISTER GRAMMAR — the law this file exists to keep:
     · a LABEL is our question       ("WHO THEY ARE")   — uppercase, tracked
     · a READ is OUR claim           ("childhood immersion") — a computed tag
     · a QUOTE is THEIR answer       (“movie/show lover since I was little”)
   The reads and the quotes must never be mistakable for each other, so they do
   not share a typeface: everything of ours is Plus Jakarta Sans, and the ONLY
   thing in IBM Plex Mono anywhere in this burst is the guest speaking, always
   inside curly quotes. (The slot geometry that carries this is documented in
   stamps/assets.ts.)

   A CARD MAY ONLY SAY WHAT THE GUEST SAID, AND MAY ONLY CLAIM WHAT WE COMPUTED.
   Reads come off the baked graph.json node; quotes come off the person record's
   `conviction.quotes` (the extraction's own verbatim receipt) or, where a tag
   ships no receipt by construction, off the raw answer that tag was read from.
   A field the guest left blank leaves its slot blank, a tag we never computed
   leaves no claim, and a card with no true fact left in it is not rendered at
   all — there is no filler anywhere downstream of this file (CLAUDE.md laws
   c + d, audit-graph obligation 3: absence renders as absence).

   TWO ARRIVALS, ONE FETCH. The reads are composed at POP time from
   GUEST_DETAILS, so what a card CLAIMS is on screen the instant it lands and
   never changes afterwards. The quotes live only in the person record, which
   PeplGraph is already fetching for the threads widget — the same object is
   handed down here (no second request), and its lines ink in a beat later, into
   slots that were empty, never over a placeholder. Which cards exist is decided
   by the reads alone, so a record landing can add words to a card but can never
   add or remove one. */

import { useMemo } from "react";
import { NAMETAG_SVG, BELIEF_STAMP_SVG, ROUND_STAMP_SVG } from "./stamps/assets";
import { injectSvg, withRootAttrs } from "./stamps/injectSvg";
import type { GuestDetails } from "./adapter";

export type StampData = {
  personKey: string;
  name: string;
  details: Partial<GuestDetails>;
};

/** The slice of a baked person record (public/graph/people/<id>.json) the cards
    read: the computed conviction with its verbatim receipts, and the guest's own
    answers. PeplGraph's PersonRecord is built on this — one shape, one fetch. */
export type StampRecord = {
  personId: string;
  answers?: Record<string, string>;
  conviction?: {
    motive?: string;
    mission?: string;
    impact?: string;
    aspiration?: string;
    /** verbatim, byte-for-byte from their answer; a tag a human overrode has none */
    quotes?: Record<string, string>;
  };
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

/* The line budget of each wrapping quote slot, in CHARACTERS — one less than
   what injectSvg's greedy fill will take, because the curly quotes claim a
   character at each end. IBM Plex Mono advances exactly 0.6em, so these are
   exact, not estimates: belief 208 units / (16 × 0.6) = 21, nametag 206 / (14 ×
   0.6) = 24. maxLines is the number of lines that fit BEFORE the next thing on
   the card (the belief signature at y=134; the nametag's rotated bottom edge). */
const BELIEF_QUOTE = { perLine: 20, maxLines: 3 };
const NAMETAG_QUOTE = { perLine: 23, maxLines: 3 };

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

/**
 * A verbatim line, cut to a slot's real line budget at a WORD boundary.
 *
 * `clamp` above is for a FACT — a company name, a place. This is for a QUOTE,
 * and a quote may never be cut mid-word: half a word is a sentence the guest
 * did not say. So the wrap is simulated here with injectSvg's own greedy fill
 * (same character model, exactly), whole words are dropped until the remainder
 * plus its ellipsis fits, and the ellipsis is the disclosure that there is
 * more. The full text is never lost — it stays in the person record, and the
 * receipt dialog is the surface that prints it entire.
 *
 * The one unavoidable cut is a single word longer than a whole line; it is the
 * only branch that slices inside a word, and it still ends in an ellipsis.
 */
function fitLines(raw: string, perLine: number, maxLines: number): string {
  const words = raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  let taken = 0;
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length <= perLine) {
      cur = cand;
      taken += 1;
      continue;
    }
    if (lines.length + 1 >= maxLines) break; // `cur` has to stay the last line
    if (cur) lines.push(cur);
    cur = w.length <= perLine ? w : `${w.slice(0, perLine - 1)}…`;
    taken += 1;
    if (w.length > perLine) break;
  }
  if (cur) lines.push(cur);
  if (taken >= words.length) return lines.join(" ");
  const last = lines.pop() ?? "";
  if (last.endsWith("…")) {
    lines.push(last);
    return lines.join(" ");
  }
  let head = last;
  while (head.length + 1 > perLine && head.includes(" ")) head = head.slice(0, head.lastIndexOf(" "));
  lines.push(`${head.replace(/[\s,;:.–—-]+$/, "")}…`);
  return lines.join(" ");
}

/** Their words, in the marks that say so. Empty in, empty out — a quote slot
    with nothing behind it prints nothing, never a pair of empty quotes. */
const quoted = (v: string, slot: { perLine: number; maxLines: number }) =>
  v ? `“${fitLines(v, slot.perLine, slot.maxLines)}”` : "";

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

/** One card's injected values, or null when the person gave us nothing that
    card could truthfully carry. Index = its slot in SLOTS. */
type StampFill = Record<string, string> | null;

/**
 * What the three cards are allowed to say, in the order each prefers.
 *
 * THE LADDERS (every read is a real graph.json tag, every quote a real record
 * line; a card is dropped when its ladder runs out):
 *   card 1 · belief   motive        + quotes.motive, else their raw `drew`
 *   card 3 · nametag  craft (asp)   + their raw `goal` answer
 *                     …else the old day-job ladder: company → freelance →
 *                     school → title, with the header following the fact
 *   card 2 · oval     mission → impact, over the day job and the hometown
 *                     …else the hometown, else the day job, label following
 *
 * WHY CARD 2 CARRIES NO QUOTE. mission and impact are read off the `goal`
 * answer, so their receipt is a SPAN of the same sentence card 3 prints whole —
 * in every one of the 37 records that has one. Printing both would say the same
 * thing twice in one burst, which is the one thing the no-repeat law below
 * forbids; the oval has no line long enough for a sentence anyway. The goal
 * line prints once, on card 3, where it is whole.
 *
 * WHY ONE VALUE TAG, NOT TWO. mission and impact are near-synonyms in this
 * vocabulary ("joy-positivity" / "bring-joy", "representation-feel-seen" /
 * "make-people-feel-seen"). One is the read; the second is an echo.
 *
 * Nothing is printed twice in one burst: the first card to claim a value owns
 * it, and later cards fall to their next real rung instead of echoing it. The
 * cards are therefore composed in claim order — 1, then 3, then 2, which is why
 * the facts card runs last and takes what is left.
 */
export function compose(
  data: StampData,
  record?: StampRecord | null,
): [StampFill, StampFill, StampFill] {
  const d = data.details;
  const t = (v: string | undefined) => (v ?? "").trim();
  const school = t(d.school);
  const company = t(d.company);
  const title = t(d.title);
  const motive = t(d.group);
  const craft = t(d.craft);
  const mission = t(d.mission);
  const impact = t(d.impact);
  const home = place(t(d.hometown));
  /* one line for where the day goes. "Freelance" is the `free` flag, a fact the
     guest stated by answering the company question with the form's own
     freelance word; it is never inferred from an empty cell. */
  const dayJob = company || (d.free ? "Freelance" : "") || school;

  /* THEIR WORDS — record-only, and only ever this person's. The record arrives
     on a fetch keyed by the focused person, and a burst can outlive a focus
     change, so the id is checked here rather than trusted. */
  const rec = record && record.personId === data.personKey ? record : null;
  const said = (k: "motive" | "mission" | "impact") => t(rec?.conviction?.quotes?.[k]);
  const answered = (k: string) => t(rec?.answers?.[k]);

  const used = new Set<string>();
  const claim = (v: string) => {
    const k = v.toLowerCase();
    if (!v || used.has(k)) return "";
    used.add(k);
    return v;
  };

  /* 1 · WHO THEY ARE — their motive, in their own words, signed.
     The quote is the extraction's receipt when there is one. When we claim NO
     motive we have no receipt to show either, so their raw answer to the
     question the motive is read from stands alone — their words under no claim
     of ours. A tag whose receipt was dropped (a human moved it) shows the tag
     and nothing else: the old quote stopped being evidence the moment the tag
     changed, and no other line of theirs is a substitute for it. */
  const read1 = claim(motive);
  const voice1 = said("motive") || (motive ? "" : answered("drew"));
  const signature = personName(data.name);
  /* the label is a QUESTION, and a question with nothing under it answers
     itself wrong: the five guests we read no conviction for and who left the
     answers blank get their signature alone, which is the whole of what we
     know about them (sarah-fan-8578 is the proof case). */
  const card1: StampFill =
    read1 || voice1 || signature
      ? {
          label: read1 || voice1 ? "WHO THEY ARE" : "",
          read: read1,
          quote: quoted(voice1, BELIEF_QUOTE),
          name: signature,
        }
      : null;

  /* 3 · WHAT THEY'RE WORKING TOWARD — their craft, over their goal answer.
     `aspiration` is the one conviction tag that ships no receipt (it is read
     off `goal`, and its quote would only ever restate mission's — see
     scripts/emit-graph.ts QUOTED_TAGS), so the verbatim here is the raw answer
     itself, whole and elided, which is what the field is.
     With no craft there is no trajectory to claim, and the card falls back to
     the day job it has always been — header following the fact it stands over,
     and no goal quote under a header that is not about goals. */
  let card3: StampFill = null;
  if (craft) {
    card3 = {
      label: "WORKING TOWARD",
      read: clamp(claim(craft), 34),
      quote: quoted(answered("goal"), NAMETAG_QUOTE),
    };
  } else if (company) {
    card3 = { label: "THE DAY JOB", read: clamp(claim(company), 34), quote: "" };
  } else if (d.free) {
    card3 = { label: "THE DAY JOB", read: "Freelance", quote: "" };
  } else if (school) {
    card3 = { label: "THE SCHOOL", read: clamp(claim(school), 34), quote: "" };
  } else if (title) {
    card3 = { label: "THE DAY JOB", read: clamp(claim(title), 34), quote: "" };
  }

  /* 2 · WHAT THEY VALUE — the one value tag, over the two facts that survived
     the old burst (the day job and the hometown; a title and a school standing
     behind a company are the drops). 182 of the 312 were read for no value at
     all, so the label follows the content down the ladder rather than standing
     over an empty card. */
  const value = claim(mission) || claim(impact);
  let card2: StampFill = null;
  if (value) {
    const from = clamp(claim(home), 13);
    card2 = {
      ringText: RING,
      label: "WHAT THEY VALUE",
      read: clamp(value, 26),
      factOne: clamp(claim(dayJob), 23),
      factTwo: from ? `from ${from}` : "",
    };
  } else if (home) {
    card2 = {
      ringText: RING,
      label: "WHERE THEY'RE FROM",
      read: clamp(claim(home), 20),
      factOne: clamp(claim(dayJob), 23),
      factTwo: "",
    };
  } else if (dayJob) {
    card2 = {
      ringText: RING,
      label: "THE DAY JOB",
      read: clamp(claim(dayJob), 23),
      factOne: "",
      factTwo: "",
    };
  }

  // slot order — nametag left, belief middle, oval right
  return [card3, card1, card2];
}

export default function StampBurst({
  data,
  on,
  record,
}: {
  data: StampData;
  on: boolean;
  /** the person record PeplGraph already fetched — the quotes' only source */
  record?: StampRecord | null;
}) {
  const stamps = useMemo(() => {
    const [nametag, card, round] = compose(data, record);
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
  }, [data, record]);

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
        /* the guest's own line arrives a beat after the card (one fetch, see the
           header) and inks in where there was nothing — the slot is empty until
           it lands, so this fades in real words and never replaces a stand-in */
        .pepl-stamp text[data-voice="theirs"] {
          animation: stampInk 380ms ease-out both;
        }
        @keyframes stampInk {
          from { opacity: 0; }
          to { opacity: 1; }
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
          .pepl-stamp text[data-voice="theirs"] { animation: none; }
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
