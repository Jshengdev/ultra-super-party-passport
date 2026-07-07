"use client";

/**
 * The entry experience (raw/0020): the passport cover, "what's your name?",
 * Discover your passport → /passport/<id>?reveal=1 (the live-generation reveal),
 * and the door: Enter the Social Universe. Tailwind + framer-motion; design
 * language referenced from pepl, all colors routed through Teri-ownable tokens.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";

interface GNode {
  id: string;
  label: string;
  type: string;
}

export default function Entry() {
  const router = useRouter();
  const [people, setPeople] = useState<GNode[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(process.env.NEXT_PUBLIC_GRAPH_API || "/api/graph")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`graph ${r.status}`))))
      .then((g) => setPeople((g.nodes as GNode[]).filter((n) => n.type === "Person")))
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return people.filter((p) => p.label.toLowerCase().includes(s)).slice(0, 6);
  }, [q, people]);

  return (
    <main className="min-h-screen flex justify-center bg-cloud text-charcoal">
      <div className="w-[min(440px,92vw)] flex flex-col items-center gap-5 py-12 pb-16">
        <motion.input
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="w-full rounded-full border border-mist bg-white px-6 py-4 text-center text-[17px] outline-none transition-colors focus:border-ocean"
          placeholder="what’s your name?"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="what's your name?"
        />

        <AnimatePresence>
          {matches.length > 0 && (
            <motion.ul
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="w-full flex flex-col gap-1.5 overflow-hidden"
            >
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => router.push(`/passport/${m.id}?reveal=1`)}
                    className="w-full flex items-baseline justify-between rounded-2xl border border-mist bg-white px-5 py-3 text-[15px] hover:border-ocean transition-colors cursor-pointer"
                  >
                    <span>{m.label}</span>
                    <span className="text-[12.5px] text-stone">discover your passport →</span>
                  </button>
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
        {q.trim().length >= 2 && matches.length === 0 && people.length > 0 && (
          <p className="text-[13px] text-stone">not on this guest list yet — find yourself in the room instead</p>
        )}
        {err && <p className="text-[13px] text-stone">guest list unavailable: {err}</p>}

        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
          className="relative w-full overflow-hidden rounded-[22px] shadow-[0_24px_60px_rgba(42,42,40,0.14)]"
          style={{ aspectRatio: "3 / 4.1", background: "#f1f1ee" }}
          role="img"
          aria-label="your passport cover"
        >
          <p className="absolute top-4 left-0 right-0 z-10 text-center font-mono text-[11px] tracking-[0.18em] opacity-70">
            THE ULTRA SUPER SOCIAL PASSPORT
          </p>
          <div
            className="absolute inset-0 scale-[1.12]"
            style={{
              background: `
                radial-gradient(120% 55% at 50% 108%, var(--color-ocean) 0%, transparent 62%),
                radial-gradient(120% 52% at 50% 88%, var(--color-sky) 0%, transparent 60%),
                radial-gradient(130% 48% at 50% 66%, var(--color-gold) 0%, transparent 58%),
                radial-gradient(130% 44% at 50% 48%, var(--color-sunset-orange) 0%, transparent 56%),
                radial-gradient(140% 40% at 50% 32%, var(--color-sunset-pink) 0%, transparent 54%)`,
              filter: "blur(18px) saturate(1.15)",
            }}
          />
          <p className="absolute bottom-4 left-0 right-0 z-10 text-center font-mono text-[11px] tracking-[0.18em] opacity-70">
            IYA WELCOME BACK · LOS ANGELES
          </p>
        </motion.div>

        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.45 }}
          onClick={() => router.push("/universe")}
          className="mt-1 rounded-full bg-charcoal px-7 py-3.5 text-[15.5px] text-cloud hover:opacity-90 transition-opacity cursor-pointer"
        >
          Enter the Social Universe
        </motion.button>
        <p className="text-center text-[12px] text-stone">
          every claim on every passport traces to a real connection in the room
        </p>
      </div>
    </main>
  );
}
