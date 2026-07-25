"use client";

/* The RSVP detail burst: three passport stamps pop out around a
   person's dot (top left · middle · right), each carrying their
   details, then peel off when the person is released.

   nametag (blue)  — school small, company large
   belief (card)   — one-word title, favorite movie, signed name
   round (oval)    — hometown centre, instagram ring, full title    */

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

function ringText(handle: string) {
  const h = handle || "@somewhere";
  let s = h;
  while (s.length < 42) s += "   ·   " + h;
  return s.slice(0, 64);
}

export default function StampBurst({ data, on }: { data: StampData; on: boolean }) {
  const svgs = useMemo(() => {
    const d = data.details;
    const school = d.school || "somewhere";
    const company = d.company || "freelance";
    const title = d.title || "creative";
    const hometown = d.hometown || "planet earth";
    const instagram = d.instagram || "@offline";
    /* the square stamp carries their conviction now: group in the middle,
       craft in the corner. Fallbacks never invent — a folded person with
       no craft keeps the old title-word + "no comment". */
    const small = d.group && d.craft ? d.craft : firstWord(title);
    const middle = d.group || d.craft || d.movie || "no comment";
    try {
      return [
        injectSvg(NAMETAG_SVG, {
          headerLabel: "THE DAY JOB",
          org: school,
          name: company,
        }),
        injectSvg(BELIEF_STAMP_SVG, {
          small,
          belief: middle.length > 48 ? middle.slice(0, 46) + "…" : middle,
          name: data.name.toLowerCase(),
        }),
        injectSvg(ROUND_STAMP_SVG, {
          relation: hometown,
          ringText: ringText(instagram),
          name: title.toLowerCase(),
        }),
      ].map((svg) => withRootAttrs(svg, { width: "100%", height: "100%" }));
    } catch (e) {
      console.error("[stamps]", e);
      return null;
    }
  }, [data]);

  if (!svgs) return null;

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
      {SLOTS.map((slot, i) => (
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
          dangerouslySetInnerHTML={{ __html: svgs[i] }}
        />
      ))}
    </div>
  );
}
