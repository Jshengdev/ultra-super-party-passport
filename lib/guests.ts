/**
 * lib/guests.ts — CSV → Guest[]. Parse the real Luma-style guest export, keep only
 * approved rows, dedupe by guest_id, canonicalize school/company, repair doubled
 * names, and mint a non-PII personId (slug(name) + first 4 hex of sha256(guest_id) —
 * never derived from email). Consumed by a later ingest task; keep signatures pinned
 * by the task-2 brief exact.
 */
import Papa from "papaparse";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface Guest {
  personId: string; guestId: string; name: string; title: string;
  school: string | null; company: string | null; isFreelance: boolean;
  hometown: string | null; instagram: string | null; createdAt: string;
  answers: { goal: string; drew: string; seeking: string; inspiration: string; favorite: string };
  flags: string[];
}

const COL = {
  company: 'Company? (if you are freelance, just say "creative")',
  title: 'Job title? (if you are freelance, just state your typical role e.g. "Director")',
  hometown: "Hometown?", instagram: "Instagram handle?", school: "School? (e.g. USC '27)",
  favorite: "Favorite movie/show?", drew: "What drew you to the entertainment industry?",
  goal: "Whats your ultimate goal in pursuing entertainment? (e.g. being a director, representation, etc.)",
  seeking: "What kind of people are you looking to connect with?", inspiration: "Who is your biggest inspiration?",
} as const;

const SCHOOL_ALIAS: Record<string, string> = { usc: "USC", "university of southern california": "USC", ucla: "UCLA", "uc berkeley": "UC Berkeley", berkeley: "UC Berkeley", ucsd: "UCSD", uci: "UC Irvine", chapman: "Chapman", "chapman university": "Chapman", emerson: "Emerson", "emerson college": "Emerson", "ut austin": "UT Austin", artcenter: "ArtCenter", "art center": "ArtCenter", "artcenter college of design": "ArtCenter", calarts: "CalArts", gt: "Georgia Tech", "georgia tech": "Georgia Tech", lmu: "LMU", csun: "CSUN", csulb: "CSULB", nyu: "NYU", vanderbilt: "Vanderbilt", "vanderbilt university": "Vanderbilt", "smith college": "Smith", pitt: "Pitt", northwestern: "Northwestern", emory: "Emory", "cal poly pomona": "Cal Poly Pomona", lcad: "LCAD" };
const CO_ALIAS: Record<string, string> = { nbcu: "NBCUniversal", nbcuniversal: "NBCUniversal", "nbcuniversal (universal studios hollywood)": "NBCUniversal", disney: "Disney", "the walt disney company": "Disney", "warner brothers discovery": "Warner Bros Discovery", "warner bros discovery": "Warner Bros Discovery", dreamworks: "DreamWorks", "dreamworks animation": "DreamWorks", "live nation": "Live Nation", "sony music entertainment": "Sony Music", "amc networks": "AMC Networks" };
const FREELANCE = new Set(["creative", "freelance", "freelancer", "independent", "self", "myself", "n/a", "na", "none", "student", ""]);

export function fixDoubledName(n: string): string {
  const t = n.replace(/\s+/g, " ").trim();
  const h = Math.floor(t.length / 2);
  return t.length > 8 && t.length % 2 === 0 && t.slice(0, h).trim() === t.slice(h).trim() ? t.slice(0, h).trim() : t;
}
export function canonSchool(raw: string): string | null {
  let s = raw.trim().replace(/[’'`‘]?\s*\d{2,4}\s*[’'‘]?\s*$/u, "").replace(/\s+/g, " ").replace(/[,.’'‘]+$/u, "").trim();
  if (s.includes("/")) s = s.split("/")[0].trim();
  if (!s) return null;
  return SCHOOL_ALIAS[s.toLowerCase()] ?? s;
}
export function canonCompany(raw: string): { company: string | null; isFreelance: boolean } {
  const k = raw.trim().replace(/\s+/g, " ").toLowerCase().replace(/[,.]+$/, "");
  if (FREELANCE.has(k)) return { company: null, isFreelance: raw.trim() !== "" };
  // The real CSV has NBCUniversal variants beyond the literal CO_ALIAS keys (e.g.
  // "NBCUniversal (NBC4 LA)") — any "nbcu*" spelling merges to the canonical name.
  if (k.startsWith("nbcu")) return { company: "NBCUniversal", isFreelance: false };
  return { company: CO_ALIAS[k] ?? raw.trim(), isFreelance: false };
}
export function personIdOf(name: string, guestId: string): string {
  const slug = fixDoubledName(name).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
  return `${slug}-${createHash("sha256").update(guestId).digest("hex").slice(0, 4)}`;
}
export const GOLDEN_NAMES = ["Jazmin Paige Lopez", "Vianne Nguyen", "George", "TJ Jalloh", "Michael Vainshtein", "Kayla McIntyre", "Tyler Bumgarner", "Crystal Qianhui Xu", "Keona Edwards", "Maggie Lee"];

interface CsvRow {
  guest_id: string;
  name: string;
  approval_status: string;
  created_at: string;
  [key: string]: string | undefined;
}

function trimmed(v: string | undefined): string {
  return (v ?? "").trim();
}

export function loadGuests(csvPath: string): Guest[] {
  let text = readFileSync(csvPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM if present pre-parse

  const res = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => (h.charCodeAt(0) === 0xfeff ? h.slice(1) : h),
  });
  if (res.errors.length) {
    const sample = res.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join(" | ");
    throw new Error(`loadGuests: ${res.errors.length} CSV error(s) — ${sample}`);
  }

  const approved = res.data.filter((r) => trimmed(r.approval_status).toLowerCase() === "approved");

  const seen = new Set<string>();
  const guests: Guest[] = [];
  for (const row of approved) {
    const guestId = trimmed(row.guest_id);
    if (!guestId || seen.has(guestId)) continue; // dedupe by guest_id, keep first
    seen.add(guestId);

    const name = fixDoubledName(trimmed(row.name));
    const school = canonSchool(trimmed(row[COL.school]));
    const { company, isFreelance } = canonCompany(trimmed(row[COL.company]));

    const answers = {
      goal: trimmed(row[COL.goal]),
      drew: trimmed(row[COL.drew]),
      seeking: trimmed(row[COL.seeking]),
      inspiration: trimmed(row[COL.inspiration]),
      favorite: trimmed(row[COL.favorite]),
    };

    const flags: string[] = [];
    if (!school) flags.push("missing-school");
    if (Object.values(answers).every((v) => v === "")) flags.push("missing-answers");

    guests.push({
      personId: personIdOf(name, guestId),
      guestId,
      name,
      title: trimmed(row[COL.title]),
      school,
      company,
      isFreelance,
      hometown: trimmed(row[COL.hometown]) || null,
      instagram: trimmed(row[COL.instagram]) || null,
      createdAt: trimmed(row.created_at),
      answers,
      flags,
    });
  }

  return guests;
}
