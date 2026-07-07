"use client";

/**
 * The live-generation reveal (raw/0020): when the visitor arrives via
 * "Discover your passport" (?reveal=1), they WATCH the passport get made —
 * profile processed as a node → connections drawn → the passport appears.
 * The staging is theater; the data underneath is real (the connection count
 * shown is the person's actual receipt-edge count).
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export default function Reveal({
  name,
  connections,
  children,
}: {
  name: string;
  connections: number;
  children: React.ReactNode;
}) {
  const [stage, setStage] = useState<"idle" | "node" | "edges" | "done">("idle");

  useEffect(() => {
    const wantsReveal =
      typeof window !== "undefined" && new URLSearchParams(window.location.search).get("reveal") === "1";
    if (!wantsReveal) {
      setStage("done");
      return;
    }
    setStage("node");
    const t1 = setTimeout(() => setStage("edges"), 1400);
    const t2 = setTimeout(() => setStage("done"), 3000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div className="relative w-full">
      <AnimatePresence>
        {stage !== "done" && stage !== "idle" && (
          <motion.div
            key="theater"
            exit={{ opacity: 0, transition: { duration: 0.45 } }}
            className="flex min-h-[60vh] flex-col items-center justify-center gap-6"
          >
            <motion.div
              className="h-4 w-4 rounded-full bg-ocean"
              animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut" }}
            />
            <AnimatePresence mode="wait">
              {stage === "node" && (
                <motion.p
                  key="s1"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="font-mono text-[13px] tracking-[0.14em] text-stone"
                >
                  PROCESSING {name.toUpperCase()} AS A NODE…
                </motion.p>
              )}
              {stage === "edges" && (
                <motion.p
                  key="s2"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="font-mono text-[13px] tracking-[0.14em] text-stone"
                >
                  DRAWING {connections} REAL CONNECTIONS…
                </motion.p>
              )}
            </AnimatePresence>
            {stage === "edges" && (
              <svg width="220" height="60" viewBox="0 0 220 60" fill="none" aria-hidden>
                {[0, 1, 2, 3, 4].map((i) => (
                  <motion.line
                    key={i}
                    x1={110}
                    y1={30}
                    x2={20 + i * 45}
                    y2={i % 2 ? 8 : 52}
                    stroke="var(--color-sky)"
                    strokeWidth="1.5"
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 0.8 }}
                    transition={{ duration: 0.5, delay: i * 0.12 }}
                  />
                ))}
              </svg>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {stage === "done" && (
        <motion.div
          initial={{ opacity: 0, y: 26, scale: 0.965 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          {children}
        </motion.div>
      )}
    </div>
  );
}
