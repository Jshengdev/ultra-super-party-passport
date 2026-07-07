"use client";

/**
 * The demo's first page (raw/0025 + raw/0026): drop the guest-list CSV → the
 * analysis plays out as one continuous, longer act — every number on screen is
 * parsed client-side from the actual file dropped (papaparse) — then the room
 * opens at /universe. Copy stays room-worded (nodes, threads, the room).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence, animate } from "framer-motion";
import Papa from "papaparse";

/* ---------------------------------------------------------------- real stats */

type CsvStats = {
  total: number;
  pending: number | null; // rows whose status column reads "pending…"
  schools: number | null; // distinct schools after normalization
  variantCount: number | null; // spellings folded into the most-collapsed school
  variantName: string | null;
  crafts: number | null; // distinct "what you do" entries
  beliefs: number | null; // non-empty answers to the creative question
};

function analyzeRows(rows: Record<string, unknown>[], fields: string[]): CsvStats {
  const findField = (re: RegExp) => fields.find((f) => re.test(f)) ?? null;
  const statusField = findField(/status|approval/i);
  const schoolField = findField(/school|university|college/i);
  const craftField = findField(/what[_ ]?you[_ ]?do|role|craft|discipline/i);
  const beliefField = findField(/belief|creative/i);

  const val = (row: Record<string, unknown>, f: string) =>
    typeof row[f] === "string" ? (row[f] as string).trim() : "";

  let pending = statusField ? 0 : null;
  let beliefs = beliefField ? 0 : null;
  const craftSet = craftField ? new Set<string>() : null;
  // normalized school key → (raw spelling → occurrences)
  const schoolGroups = schoolField ? new Map<string, Map<string, number>>() : null;

  for (const row of rows) {
    if (statusField && val(row, statusField).toLowerCase().startsWith("pend")) pending! += 1;
    if (beliefField && val(row, beliefField)) beliefs! += 1;
    if (craftField && craftSet) {
      const c = val(row, craftField).toLowerCase();
      if (c) craftSet.add(c);
    }
    if (schoolField && schoolGroups) {
      const raw = val(row, schoolField);
      if (raw) {
        const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
        const group = schoolGroups.get(key) ?? new Map<string, number>();
        group.set(raw, (group.get(raw) ?? 0) + 1);
        schoolGroups.set(key, group);
      }
    }
  }

  let variantCount: number | null = null;
  let variantName: string | null = null;
  if (schoolGroups) {
    for (const group of schoolGroups.values()) {
      if (group.size > 1 && group.size > (variantCount ?? 1)) {
        variantCount = group.size;
        // the most frequent raw spelling is the name the node keeps
        variantName = [...group.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
    }
  }

  return {
    total: rows.length,
    pending,
    schools: schoolGroups && schoolGroups.size > 0 ? schoolGroups.size : null,
    variantCount,
    variantName,
    crafts: craftSet && craftSet.size > 0 ? craftSet.size : null,
    beliefs,
  };
}

/* -------------------------------------------------------------- the 7 beats */

type Beat = { label: string; detail: string };

function buildBeats(stats: CsvStats): Beat[] {
  const n = stats.total;
  return [
    {
      label: "Reading the guest list…",
      detail: "every row, top to bottom — nothing skimmed",
    },
    {
      label: n > 0 ? `${n} guests parsed` : "Counting the guests…",
      detail:
        stats.pending != null && stats.pending > 0
          ? `${stats.pending} still pending — they're in the picture too`
          : "every RSVP accounted for",
    },
    {
      label: "Normalizing schools & majors…",
      detail:
        stats.variantCount && stats.variantName
          ? `${stats.variantCount} spellings of ${stats.variantName} resolved to one node`
          : stats.schools
            ? `${stats.schools} schools, each resolved to a single node`
            : "every school resolved to a single node",
    },
    {
      label: "Mapping who does what…",
      detail: stats.crafts
        ? `${stats.crafts} distinct crafts under one roof`
        : "designers, engineers, founders — each given a place",
    },
    {
      label: "Reading what everyone believes…",
      detail: stats.beliefs
        ? `${stats.beliefs} answers to “what does it mean to be creative?”`
        : "“what does it mean to be creative?” — every answer, in full",
    },
    {
      label: "Weaving shared-value ties…",
      detail: "guests who believe the same thing get a thread between them",
    },
    {
      label: "Drawing the room…",
      detail: n > 0 ? `all ${n} placed by what they share` : "everyone placed by what they share",
    },
  ];
}

// per-beat hold times (ms); sums to ~10.9s, +intro delay +enter hold ≈ 13.2s total
const BEAT_MS = [1400, 1700, 1550, 1550, 1750, 1500, 1450];
const ENTER_MS = 1950;

/* ---------------------------------------------- the growing sketch (visual) */

const SKETCH_NODES: { x: number; y: number; r: number; tint: number; at: number }[] = [
  { x: 110, y: 78, r: 5.0, tint: 0, at: 0 }, // the hub — pulses
  { x: 64, y: 46, r: 3.4, tint: 2, at: 1 },
  { x: 158, y: 54, r: 3.6, tint: 3, at: 1 },
  { x: 84, y: 114, r: 3.2, tint: 0, at: 2 },
  { x: 148, y: 108, r: 3.5, tint: 6, at: 2 },
  { x: 36, y: 86, r: 2.8, tint: 5, at: 3 },
  { x: 186, y: 88, r: 3.0, tint: 4, at: 3 },
  { x: 104, y: 26, r: 2.8, tint: 1, at: 4 },
  { x: 190, y: 32, r: 2.4, tint: 7, at: 4 },
  { x: 28, y: 32, r: 2.6, tint: 6, at: 5 },
  { x: 66, y: 138, r: 2.6, tint: 3, at: 5 },
  { x: 154, y: 140, r: 2.8, tint: 2, at: 5 },
];

const SKETCH_EDGES: { a: number; b: number; at: number; tie?: boolean }[] = [
  { a: 0, b: 1, at: 2 },
  { a: 0, b: 2, at: 2 },
  { a: 0, b: 3, at: 3 },
  { a: 0, b: 4, at: 3 },
  { a: 1, b: 7, at: 4 },
  { a: 2, b: 8, at: 4 },
  { a: 3, b: 5, at: 5, tie: true },
  { a: 4, b: 6, at: 5, tie: true },
  { a: 1, b: 3, at: 5, tie: true },
  { a: 2, b: 4, at: 5, tie: true },
  { a: 9, b: 1, at: 6 },
  { a: 10, b: 3, at: 6, tie: true },
  { a: 11, b: 4, at: 6, tie: true },
  { a: 7, b: 2, at: 6, tie: true },
];

function RoomSketch({ beat, entering }: { beat: number; entering: boolean }) {
  const hub = SKETCH_NODES[0];
  return (
    <motion.svg
      viewBox="0 0 220 156"
      className="h-[168px] w-[236px]"
      animate={entering ? { scale: 1.35, opacity: 0.22 } : { scale: 1, opacity: 1 }}
      transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
      aria-hidden
    >
      {SKETCH_EDGES.map((e, i) =>
        beat >= e.at ? (
          <motion.line
            key={`e${i}`}
            x1={SKETCH_NODES[e.a].x}
            y1={SKETCH_NODES[e.a].y}
            x2={SKETCH_NODES[e.b].x}
            y2={SKETCH_NODES[e.b].y}
            style={{ stroke: e.tie ? "var(--usp-link-share)" : "var(--usp-link-faint)" }}
            strokeWidth={e.tie ? 1.4 : 1}
            strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
        ) : null,
      )}
      {SKETCH_NODES.map((node, i) =>
        beat >= node.at ? (
          i === 0 ? (
            <g key="hub">
              <motion.circle
                cx={hub.x}
                cy={hub.y}
                style={{ fill: "none", stroke: "var(--usp-accent)" }}
                strokeWidth={1}
                initial={{ r: hub.r, opacity: 0.45 }}
                animate={{ r: [hub.r, hub.r * 3.4], opacity: [0.45, 0] }}
                transition={{ repeat: Infinity, duration: 1.6, ease: "easeOut" }}
              />
              <motion.circle
                cx={hub.x}
                cy={hub.y}
                style={{ fill: "var(--usp-accent)" }}
                initial={{ r: 0 }}
                animate={{ r: [hub.r, hub.r * 1.25, hub.r] }}
                transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
              />
            </g>
          ) : (
            <motion.circle
              key={`n${i}`}
              cx={node.x}
              cy={node.y}
              style={{
                fill: `var(--usp-spectrum-${node.tint})`,
                stroke: "var(--usp-ring)",
              }}
              strokeWidth={0.8}
              initial={{ r: 0, opacity: 0 }}
              animate={{ r: node.r, opacity: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 18 }}
            />
          )
        ) : null,
      )}
    </motion.svg>
  );
}

/* -------------------------------------------------------------------- page */

export default function AnalyzePage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [stats, setStats] = useState<CsvStats | null>(null);
  const [beatIdx, setBeatIdx] = useState(-1);
  const [phase, setPhase] = useState<"idle" | "running" | "entering">("idle");
  const [countStr, setCountStr] = useState("0");

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  // the count-up: 0 → the real parsed total, while the first beats play
  useEffect(() => {
    if (phase === "running" && stats && stats.total > 0) {
      const ctrl = animate(0, stats.total, {
        duration: 1.7,
        ease: "easeOut",
        onUpdate: (v) => setCountStr(String(Math.round(v))),
      });
      return () => ctrl.stop();
    }
  }, [phase, stats]);

  const beats = useMemo(() => (stats ? buildBeats(stats) : []), [stats]);

  const runAnalysis = useCallback(
    (s: CsvStats) => {
      setStats(s);
      setPhase("running");
      let t = 350;
      BEAT_MS.forEach((d, i) => {
        timers.current.push(setTimeout(() => setBeatIdx(i), t));
        t += d;
      });
      timers.current.push(setTimeout(() => setPhase("entering"), t));
      timers.current.push(setTimeout(() => router.push("/universe"), t + ENTER_MS));
    },
    [router],
  );

  const onFile = useCallback(
    (file: File) => {
      setFileName(file.name);
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => runAnalysis(analyzeRows(res.data, res.meta.fields ?? [])),
        error: () => runAnalysis(analyzeRows([], [])),
      });
    },
    [runAnalysis],
  );

  const progress = phase === "entering" ? 1 : (beatIdx + 1) / BEAT_MS.length;

  return (
    <main className="min-h-screen flex items-center justify-center bg-cloud text-charcoal">
      <div className="w-[min(560px,92vw)] flex flex-col items-center gap-8 py-16">
        <AnimatePresence mode="wait">
          {phase === "idle" ? (
            <motion.div
              key="drop"
              exit={{ opacity: 0, y: -10 }}
              className="w-full flex flex-col items-center gap-7"
            >
              {/* the pill IS the door — reference: the Dia card page (raw screenshot, 3:24pm) */}
              <motion.button
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: "easeOut" }}
                onClick={() => fileRef.current?.click()}
                className="w-[min(420px,86vw)] rounded-full border border-mist bg-white px-8 py-4 text-center text-[16.5px] font-medium hover:border-charcoal transition-colors cursor-pointer shadow-[0_10px_36px_rgba(42,42,40,0.08)]"
              >
                drop the guest list
              </motion.button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />

              {/* the card: soft grey field, vivid stepped bands blooming from the bottom */}
              <motion.div
                initial={{ opacity: 0, y: 26, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
                onClick={() => fileRef.current?.click()}
                className="relative w-[min(420px,86vw)] cursor-pointer overflow-hidden rounded-[26px] shadow-[0_30px_80px_rgba(42,42,40,0.16)]"
                style={{ aspectRatio: "3 / 4.35", background: "#f2f1ee" }}
                role="img"
                aria-label="the passport cover — drop a guest list to begin"
              >
                <p className="absolute top-5 left-0 right-0 z-10 text-center font-mono text-[10.5px] tracking-[0.22em] text-charcoal/60">
                  THE ULTRA SUPER SOCIAL PASSPORT<sup style={{ fontSize: "0.42em", opacity: 0.65, letterSpacing: 0 }}>™</sup>
                </p>
                {/* stepped bloom: three columns, center swell — saturated, lightly blurred so the bands keep their step */}
                <div
                  className="absolute inset-x-0 bottom-0 h-[94%]"
                  style={{
                    background: `
                      linear-gradient(180deg,
                        rgba(247,246,243,0) 0%, #f3dfe0 16%, #f1c9a6 34%, #ecd39f 50%,
                        #cdd8b9 66%, #94b0d4 86%, #7f9fc9 100%)
                    `,
                    filter: "blur(14px) saturate(1.06)",
                    transform: "scale(1.06)",
                  }}
                />
              </motion.div>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35 }}
                className="text-center text-[13px] leading-relaxed text-stone"
              >
                Every event is curated. See how this one is curated toward you.
                <br />
                <span className="text-[11.5px] opacity-80">a Luma export, a spreadsheet — any guest CSV</span>
              </motion.p>
            </motion.div>
          ) : (
            <motion.div
              key="run"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="w-full flex flex-col items-center gap-6"
            >
              <p className="max-w-full truncate font-mono text-[11px] tracking-[0.2em] text-stone">
                {fileName?.toUpperCase()}
              </p>

              <RoomSketch beat={phase === "entering" ? 99 : beatIdx} entering={phase === "entering"} />

              <AnimatePresence mode="wait">
                {phase === "entering" ? (
                  <motion.p
                    key="enter"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.7, ease: "easeOut" }}
                    className="text-[19px] font-medium"
                  >
                    Entering the room…
                  </motion.p>
                ) : (
                  <motion.div
                    key="prog"
                    exit={{ opacity: 0, y: 6, transition: { duration: 0.45 } }}
                    className="w-full flex flex-col items-center gap-5"
                  >
                    {stats && stats.total > 0 && (
                      <div className="flex items-baseline gap-2 font-mono tracking-[0.14em] text-stone">
                        <span className="text-[16px] tracking-normal text-charcoal tabular-nums">
                          {countStr}
                        </span>
                        <span className="text-[11px]">GUESTS</span>
                      </div>
                    )}

                    <div className="h-[3px] w-full overflow-hidden rounded-full bg-mist">
                      <motion.div
                        className="h-full w-full origin-left rounded-full bg-ocean"
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: progress }}
                        transition={{ duration: 0.8, ease: "easeOut" }}
                      />
                    </div>

                    <div className="flex w-full flex-col gap-3">
                      {beats.map((b, i) =>
                        i <= beatIdx ? (
                          <motion.div
                            key={i}
                            initial={{ opacity: 0, x: -14 }}
                            animate={{ opacity: i === beatIdx ? 1 : 0.45, x: 0 }}
                            transition={{ duration: 0.5, ease: "easeOut" }}
                            className="flex flex-col gap-0.5"
                          >
                            <span className="font-mono text-[13px] tracking-[0.05em]">
                              {i < beatIdx ? "✓" : "·"} {b.label}
                            </span>
                            <motion.span
                              initial={{ opacity: 0, y: 3 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: 0.4, duration: 0.5 }}
                              className="pl-[1.35em] text-[12px] text-stone"
                            >
                              {b.detail}
                            </motion.span>
                          </motion.div>
                        ) : null,
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
