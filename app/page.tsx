"use client";

/**
 * The demo's first page (raw/0025): drop the guest-list CSV → the analysis runs →
 * the room appears. The heavy graph construction is precached; this surface presents
 * the analysis as one continuous act and routes into /universe when it completes.
 * The numbers shown are REAL — parsed client-side from the actual file dropped.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import Papa from "papaparse";

type Stage = { label: string; detail?: string };

export default function AnalyzePage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<number>(0);
  const [stageIdx, setStageIdx] = useState<number>(-1);
  const [running, setRunning] = useState(false);

  const stages: Stage[] = [
    { label: `Parsing ${rows || "the"} guests…` },
    { label: "Normalizing schools & majors…", detail: "Iovine & Young Academy, six spellings, one node" },
    { label: "Mapping who does what…" },
    { label: "Reading what everyone believes…" },
    { label: "Clustering shared values…", detail: "the clouds are forming" },
    { label: "Drawing the room…" },
  ];

  const runAnalysis = useCallback(
    (csvRowCount: number) => {
      setRunning(true);
      setRows(csvRowCount);
      let i = 0;
      const tick = () => {
        setStageIdx(i);
        i += 1;
        if (i <= 5) {
          setTimeout(tick, 850 + Math.floor(csvRowCount / 2));
        } else {
          setTimeout(() => router.push("/universe"), 900);
        }
      };
      tick();
    },
    [router],
  );

  const onFile = useCallback(
    (file: File) => {
      setFileName(file.name);
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => runAnalysis(res.data.length),
        error: () => runAnalysis(0),
      });
    },
    [runAnalysis],
  );

  return (
    <main className="min-h-screen flex items-center justify-center bg-cloud text-charcoal">
      <div className="w-[min(560px,92vw)] flex flex-col items-center gap-8 py-16">
        <AnimatePresence mode="wait">
          {!running ? (
            <motion.div key="drop" exit={{ opacity: 0, y: -10 }} className="w-full flex flex-col items-center gap-6">
              <motion.p
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="font-mono text-[11px] tracking-[0.2em] text-stone"
              >
                THE ULTRA SUPER SOCIAL PASSPORT
              </motion.p>
              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="text-center text-[30px] leading-tight font-medium"
              >
                Every event is curated.
                <br />
                See how this one is curated toward you.
              </motion.h1>
              <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.25 }}
                onClick={() => fileRef.current?.click()}
                className="rounded-full bg-charcoal px-8 py-4 text-[15.5px] text-cloud hover:opacity-90 transition-opacity cursor-pointer"
              >
                Drop the guest list
              </motion.button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />
              <p className="text-[12.5px] text-stone">a Luma export, a spreadsheet — any guest CSV</p>
            </motion.div>
          ) : (
            <motion.div key="run" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="w-full flex flex-col items-center gap-7">
              <p className="font-mono text-[11px] tracking-[0.2em] text-stone">{fileName?.toUpperCase()}</p>
              <motion.div
                className="h-3.5 w-3.5 rounded-full bg-ocean"
                animate={{ scale: [1, 1.6, 1], opacity: [0.45, 1, 0.45] }}
                transition={{ repeat: Infinity, duration: 1.15, ease: "easeInOut" }}
              />
              <div className="flex w-full flex-col gap-2.5">
                {stages.map((s, i) => (
                  <AnimatePresence key={s.label}>
                    {i <= stageIdx && (
                      <motion.div
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: i === stageIdx ? 1 : 0.45 }}
                        className="flex items-baseline justify-between"
                      >
                        <span className="font-mono text-[13px] tracking-[0.06em]">
                          {i < stageIdx ? "✓ " : "· "}
                          {s.label}
                        </span>
                        {s.detail && i === stageIdx && (
                          <span className="text-[11.5px] text-stone">{s.detail}</span>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
