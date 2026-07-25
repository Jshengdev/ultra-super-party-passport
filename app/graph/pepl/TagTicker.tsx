"use client";

/* The tag ticker: two counter-scrolling rows docked to the bottom —
   schools on top (drifting right-to-left), companies with logos below
   (drifting left-to-right) — with connector curves between a school
   and the companies its people went to, drawn live as both rows move. */

import { useEffect, useRef } from "react";
import {
  TICKER_SCHOOLS,
  TICKER_COMPANIES,
  SCHOOL_COMPANY_PAIRS,
} from "./adapter";

/** How much of the bottom the ticker docks — the scene anchors above it. */
export const TICKER_HEIGHT = 100;
const ROW_TOP_Y = 14; // school row top
const ROW_BOT_Y = 58; // company row top
const ROW_H = 30;

export default function TagTicker() {
  const rootRef = useRef<HTMLDivElement>(null);
  const topTrackRef = useRef<HTMLDivElement>(null);
  const botTrackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const topTrack = topTrackRef.current;
    const botTrack = botTrackRef.current;
    const canvas = canvasRef.current;
    if (!root || !topTrack || !botTrack || !canvas) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* measure one copy of each row (children are duplicated ×2) */
    const measure = (track: HTMLDivElement, count: number) => {
      const kids = Array.from(track.children).slice(0, count) as HTMLElement[];
      const widths = kids.map((k) => k.offsetWidth + 26); // + gap
      const cum: number[] = [];
      let acc = 0;
      for (const wdt of widths) {
        cum.push(acc);
        acc += wdt;
      }
      return { widths, cum, total: acc };
    };

    let mTop = measure(topTrack, TICKER_SCHOOLS.length);
    let mBot = measure(botTrack, TICKER_COMPANIES.length);

    const schoolIdx = new Map(TICKER_SCHOOLS.map((s, i) => [s.name, i]));
    const companyIdx = new Map(TICKER_COMPANIES.map((c, i) => [c.name, i]));

    let offTop = 0;
    let offBot = 0;
    let raf = 0;
    let last = performance.now();
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(root);

    const resize = () => {
      const vw = root.clientWidth;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(2, Math.floor(vw * dpr));
      canvas.height = Math.floor(TICKER_HEIGHT * dpr);
      canvas.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
      mTop = measure(topTrack, TICKER_SCHOOLS.length);
      mBot = measure(botTrack, TICKER_COMPANIES.length);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(root);
    /* the tracks shrink when a logo 404s to display:none and reflow
       when the webfont settles — observe them so metrics never go stale */
    ro.observe(topTrack);
    ro.observe(botTrack);
    document.fonts?.ready?.then(() => resize()).catch(() => {});

    /* centre-x of item i's nearest visible copy, or null */
    const itemX = (
      m: { widths: number[]; cum: number[]; total: number },
      i: number,
      off: number,
      vw: number
    ) => {
      const base = m.cum[i] + m.widths[i] / 2 - off;
      /* rows render exactly two copies — only these exist on screen */
      for (const copy of [0, 1]) {
        const x = base + copy * m.total;
        if (x > -60 && x < vw + 60) return x;
      }
      return null;
    };

    const draw = () => {
      const vw = root.clientWidth;
      /* top drifts left, bottom drifts right — opposite directions */
      topTrack.style.transform = `translateX(${(-offTop).toFixed(2)}px)`;
      botTrack.style.transform = `translateX(${(offBot - mBot.total).toFixed(2)}px)`;

      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, vw, TICKER_HEIGHT);
      ctx.lineWidth = 1;
      for (const p of SCHOOL_COMPANY_PAIRS) {
        const si = schoolIdx.get(p.school);
        const ci = companyIdx.get(p.company);
        if (si == null || ci == null) continue;
        const sx = itemX(mTop, si, offTop, vw);
        /* bottom track is translated by (offBot - total): item x =
           cum + w/2 + offBot - total ⇒ same formula with -offBot vs
           total-shifted copies */
        const cx = itemX(mBot, ci, mBot.total - offBot, vw);
        if (sx == null || cx == null) continue;
        ctx.strokeStyle = `rgba(145,180,249,${Math.min(0.45, 0.12 + p.n * 0.07).toFixed(2)})`;
        ctx.beginPath();
        ctx.moveTo(sx, ROW_TOP_Y + ROW_H - 4);
        ctx.bezierCurveTo(
          sx,
          ROW_TOP_Y + ROW_H + 10,
          cx,
          ROW_BOT_Y - 12,
          cx,
          ROW_BOT_Y + 2
        );
        ctx.stroke();
      }
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible) return;
      offTop = (offTop + 22 * dt) % Math.max(1, mTop.total);
      offBot = (offBot + 18 * dt) % Math.max(1, mBot.total);
      draw();
    };

    if (reduced) {
      /* static rows, one paint — no work delivered to users who
         opted out of motion; repaint only on resize/reflow */
      const roDraw = new ResizeObserver(() => draw());
      roDraw.observe(root);
      roDraw.observe(topTrack);
      roDraw.observe(botTrack);
      draw();
      return () => {
        roDraw.disconnect();
        ro.disconnect();
        io.disconnect();
      };
    }

    frame();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  const label: React.CSSProperties = {
    fontFamily: "var(--font-jakarta), sans-serif",
    letterSpacing: "0.06em",
    textTransform: "lowercase",
    whiteSpace: "nowrap",
  };

  const rowStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    display: "flex",
    gap: 26,
    alignItems: "center",
    height: ROW_H,
    willChange: "transform",
  };

  return (
    <div
      ref={rootRef}
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: TICKER_HEIGHT,
        overflow: "hidden",
        pointerEvents: "none",
        background:
          "linear-gradient(to top, rgba(255,253,251,0.92), rgba(255,253,251,0.72) 70%, rgba(255,253,251,0))",
        boxShadow: "0 -1px 0 rgba(26,25,24,0.05)",
        backdropFilter: "blur(6px)",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: TICKER_HEIGHT }}
      />
      <div ref={topTrackRef} style={{ ...rowStyle, top: ROW_TOP_Y }}>
        {[0, 1].flatMap((copy) =>
          TICKER_SCHOOLS.map((s, i) => (
            <span
              key={`${copy}-${i}`}
              style={{
                ...label,
                fontSize: 11.5,
                color: "rgba(26,25,24,0.66)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {s.domain && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/logos/schools/${s.slug}.png`}
                  alt=""
                  width={15}
                  height={15}
                  style={{ borderRadius: 4, objectFit: "contain" }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              {s.name.toLowerCase()}
              <span style={{ color: "rgba(26,25,24,0.30)", fontSize: 9, marginLeft: -1 }}>
                {s.n}
              </span>
            </span>
          ))
        )}
      </div>
      <div ref={botTrackRef} style={{ ...rowStyle, top: ROW_BOT_Y }}>
        {[0, 1].flatMap((copy) =>
          TICKER_COMPANIES.map((c, i) => (
            <span
              key={`${copy}-${i}`}
              style={{
                ...label,
                fontSize: 11,
                color: "rgba(26,25,24,0.58)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {c.domain && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/logos/${c.slug}.png`}
                  alt=""
                  width={15}
                  height={15}
                  style={{ borderRadius: 4, objectFit: "contain" }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              {c.name.toLowerCase()}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
