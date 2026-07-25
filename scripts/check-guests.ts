// scripts/check-guests.ts
import { loadGuests, GOLDEN_NAMES } from "../lib/guests";
const csv = process.env.GUESTS_CSV;
if (!csv) { console.error("GuestsCsvMissing: set GUESTS_CSV"); process.exit(2); }
const fail = (m: string) => { console.error("FAIL:", m); process.exit(1); };
const g = loadGuests(csv);
if (g.length !== 312) fail(`expected 312 unique approved, got ${g.length}`);
if (new Set(g.map(x => x.personId)).size !== 312) fail("personId collision");
if (g.some(x => x.personId.includes("@") || /gmail|\.edu/.test(x.personId))) fail("personId leaks email");
const vianne = g.find(x => x.name === "Vianne Nguyen");
if (!vianne) fail("doubled-name repair missing (Vianne Nguyen)");
const usc = g.filter(x => x.school === "USC").length;
if (usc < 60) fail(`USC canonicalization weak: ${usc}`);
const free = g.filter(x => x.isFreelance).length;
if (free < 60 || g.some(x => x.company === "Creative")) fail("freelance flag broken");
if (g.some(x => x.company && /^nbcu/i.test(x.company) && x.company !== "NBCUniversal")) fail("NBCU alias not merged");
for (const n of GOLDEN_NAMES) if (!g.some(x => x.name === n)) fail(`golden name missing: ${n}`);
console.log(`guests OK: ${g.length} unique, USC=${usc}, freelance=${free}`);
