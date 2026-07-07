// lib/passport.ts — buildPassport(personId): assemble a fully-receipted passport.
//
// WHY lines are written via the deployed pipeline (pipeline/client.ts callPipeline) when present,
// falling back to the Butterbase gateway directly (callGatewayDirect). Per the contract, pipeline/client.ts
// is another agent's file and NOT in the static shared-surface allowlist, so we reach it only through a
// runtime-optional dynamic import — it can never break this fence's typecheck, and its absence degrades
// cleanly to gateway-direct.
//
// Every LLM call is wrapped in a deterministic guard: validate output shape/grounding, retry once, then FAIL LOUD.
//   - why           : may reference ONLY entities present in that find's path_receipt (+ the two names).
//   - magic_inference: an interpretive READ of the holder's own text; never a verbatim restatement, no invented facts.

import OpenAI from "openai";
import { runInference } from "../pipeline/client";
import {
  personNeighborhood,
  sameWorkPath,
  valuesPath,
  sharedContextPath,
  standoutFacts,
  type Candidate,
  type Neighborhood,
} from "@/lib/traverse";
import {
  passportSchema,
  type Passport,
  type Find,
  type ReceiptEdge,
  type Gradient,
} from "@/passport/schema";

// ---------------------------------------------------------------------------
// LLM plumbing (fail-loud, gateway-direct with an optional deployed-pipeline preference)
// ---------------------------------------------------------------------------

// Butterbase gateway is OpenRouter-style: model ids carry a `provider/` prefix.
// Verified present via GET /v1/models; override with BUTTERBASE_MODEL if desired.
const MODEL = process.env.BUTTERBASE_MODEL || "openai/gpt-4o-mini";

function gatewayClient(): OpenAI {
  const apiKey = process.env.BUTTERBASE_API_KEY;
  const baseURL = process.env.BUTTERBASE_GATEWAY_URL;
  if (!apiKey || !baseURL) {
    throw new Error(
      "[degraded] Butterbase gateway env missing — set BUTTERBASE_API_KEY and BUTTERBASE_GATEWAY_URL. " +
        "Fail-loud, no silent fallback.",
    );
  }
  return new OpenAI({ apiKey, baseURL });
}

async function callGatewayDirect(system: string, user: string): Promise<string> {
  const res = await gatewayClient().chat.completions.create({
    model: MODEL,
    temperature: 0.7,
    max_tokens: 160,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return (res.choices?.[0]?.message?.content ?? "").trim();
}

// Why-lines are receipt-guarded free text; they go gateway-direct. The RocketRide pipe carries
// the passport_inference leg (magic_inference) via runInference — see buildMagicInference.
async function callLLM(system: string, user: string): Promise<string> {
  return callGatewayDirect(system, user);
}

function stripWrappingQuotes(s: string): string {
  return s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").trim();
}

/** Call → clean → validate → retry once → FAIL LOUD. The guard is deterministic, never the model. */
async function guarded(
  system: string,
  user: string,
  validate: (s: string) => boolean,
  label: string,
): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const nudge =
      attempt === 1 ? "\n\n(Your previous answer broke the rule. Obey the constraints EXACTLY.)" : "";
    last = stripWrappingQuotes(await callLLM(system, user + nudge));
    if (validate(last)) return last;
  }
  throw new Error(
    `[guard:${label}] LLM output failed its deterministic guard after one retry — refusing to emit an ungrounded value (fail-loud). Last output: ${JSON.stringify(
      last,
    )}`,
  );
}

// ---------------------------------------------------------------------------
// deterministic guards
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the","a","an","and","or","but","you","your","yours","they","their","them","both","who","what",
  "that","this","it","its","is","are","was","were","be","to","of","in","on","for","with","at","from",
  "as","by","into","about","because","so","if","when","while","after","before","since","also","one",
  "two","here","there","meet","ask","find","share","shared","love","loves","build","building","builds",
  "work","working","works","same","too","not","no","yes","then","than","just","like","likes","over",
]);

function normWords(s: string): string[] {
  return s
    .split(/[\s,./&()'\-–—:;!?"]+/)
    .map((t) => t.replace(/[^A-Za-z0-9]/g, "").toLowerCase())
    .filter(Boolean);
}

function allowedTokens(receipt: ReceiptEdge[], extraNames: string[]): Set<string> {
  const set = new Set<string>();
  const add = (s: string) => normWords(s).forEach((t) => set.add(t));
  for (const e of receipt) {
    add(e.from);
    add(e.to);
  }
  for (const n of extraNames) add(n);
  return set;
}

function covered(token: string, allow: Set<string>): boolean {
  const c = token.toLowerCase();
  if (allow.has(c)) return true;
  if (c.endsWith("s") && allow.has(c.slice(0, -1))) return true; // plural
  if (allow.has(c + "s")) return true;
  // hyphenated compounds (e.g. "SCI-Arc"): allowedTokens() splits on '-', properNouns() keeps
  // the compound whole — cover it when every part is covered.
  if (c.includes("-")) {
    const parts = c.split("-").filter(Boolean);
    if (parts.length > 0 && parts.every((p) => allow.has(p) || (p.endsWith("s") && allow.has(p.slice(0, -1))))) return true;
  }
  return false;
}

/** proper nouns = capitalized, len>1, not sentence-initial, not a stopword. */
function properNouns(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/);
    words.forEach((w, i) => {
      if (i === 0) return; // sentence-initial capital is grammatical
      const clean = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      if (clean.length > 1 && /^[A-Z]/.test(clean) && !STOPWORDS.has(clean.toLowerCase())) {
        out.push(clean);
      }
    });
  }
  return out;
}

/** why must cite ONLY entities present in the receipt (+ the two person names). */
function whyGuard(why: string, receipt: ReceiptEdge[], names: string[]): boolean {
  if (why.length < 8 || why.length > 400) return false;
  const allow = allowedTokens(receipt, names);
  for (const token of properNouns(why)) {
    if (!covered(token, allow)) return false; // an invented proper noun not in the receipt
  }
  return true;
}

/** magic_inference must be an interpretive read — never a verbatim restatement of the source text. */
function magicGuard(text: string, sources: string[]): boolean {
  if (text.length < 12 || text.length > 300) return false;
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const t = norm(text);
  if (!t) return false;
  for (const src of sources) {
    const s = norm(src);
    if (!s) continue;
    if (t === s) return false; // exact restatement
    if (s.length > 20 && t.includes(s)) return false; // swallowed a source line verbatim
    if (t.length > 20 && s.includes(t)) return false; // is a verbatim slice of a source line
  }
  return true;
}

// ---------------------------------------------------------------------------
// find assembly
// ---------------------------------------------------------------------------

function dedupeCandidates(cands: Candidate[], selfId: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of cands) {
    if (c.personId === selfId || seen.has(c.personId)) continue;
    seen.add(c.personId);
    out.push(c);
  }
  return out;
}

async function candidateToFind(me: Neighborhood, c: Candidate): Promise<Find> {
  const system =
    "You write ONE warm, specific sentence (max 24 words) telling a party guest why they'd want to " +
    "meet another guest. Use ONLY the names and shared thing given below. Do NOT invent companies, " +
    "schools, projects, products, or facts. Address the guest as \"you\". No emojis, no quotes.";
  const user = [
    `Guest (you): ${me.name}`,
    `Other guest: ${c.name}`,
    `The only real fact you may use: ${c.basis}${c.via ? ` (shared: ${c.via})` : ""}.`,
  ].join("\n");
  const names = [me.name, c.name];
  if (c.via) names.push(c.via);
  const why = await guarded(
    system,
    user,
    (s) => whyGuard(s, c.path_receipt, names),
    `why:${c.personId}`,
  );
  const basis_kind =
    c.viaKind === "ValueCluster" ? ("shared_value" as const)
    : c.viaKind === "Activity" || c.viaKind === "Company" ? ("same_work" as const)
    : ("shared_context" as const);
  let match_belief: string | undefined;
  if (basis_kind === "shared_value") {
    const other = await personNeighborhood(c.personId);
    match_belief = other?.beliefs[0];
  }
  return { personId: c.personId, name: c.name, why, path_receipt: c.path_receipt, basis_kind, via: c.via, match_belief };
}

async function buildHiddenPrompt(holderId: string, partyId?: string | null): Promise<string> {
  const facts = await standoutFacts(partyId);
  const target = facts.find((f) => f.personId !== holderId); // rarest distinctive fact about someone else
  if (target) {
    return `Somewhere in this room is the person behind "${target.activity}." Go find them.`;
  }
  // No activity data to anchor a hunt — an honest, non-fabricated prompt (states no fact about anyone).
  return "Find the guest whose belief makes you rethink one of your own.";
}

async function buildMagicInference(me: Neighborhood, match?: Candidate): Promise<string> {
  const sources = [...me.workingOn, ...me.beliefs].filter(Boolean);
  if (sources.length === 0) {
    // Nothing of their own to interpret — a delightful, non-invented default (asserts no fact about them).
    return "You showed up — which is already a small bet on serendipity.";
  }
  // The RocketRide leg: passport_inference through the deployed .pipe (runInference falls back
  // to the gateway until the pipe is live). Local magicGuard stays on top — the pipe's output
  // obeys the same taste law or we fall through to the gateway-guarded local path.
  if (match) {
    try {
      const out = await runInference({
        leg: "passport_inference",
        person: {
          name: me.name,
          line2: me.companies[0] ?? me.schools[0] ?? undefined,
          activities: [...me.does, ...me.workingOn].filter(Boolean),
          beliefs: me.beliefs,
          school: me.schools[0],
          major: me.majors[0],
        },
        match: { name: match.name, shared: match.via ?? match.basis, path_summary: match.basis },
      });
      if ("magic_inference" in out) {
        const m = stripWrappingQuotes(out.magic_inference);
        if (magicGuard(m, sources)) return m;
      }
    } catch {
      /* pipe leg unavailable — fall through to the gateway-guarded local path (fail-loud there) */
    }
  }
  const system =
    "You are a perceptive, kind observer. Given what someone is building and what they believe, reflect " +
    "back ONE interpretive insight about what drives them — the why beneath the what. It must be a READING, " +
    "never a restatement of their words, and must not add facts they didn't give. Delight, don't surveil. " +
    "Address them as \"you\". Max 22 words. No emojis, no quotes.";
  const user = [
    me.workingOn.length ? `Working on: ${me.workingOn.join("; ")}` : "",
    me.beliefs.length ? `Believes: ${me.beliefs.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return guarded(system, user, (s) => magicGuard(s, sources), "magic_inference");
}

// deterministic gradient from stable hashes (FNV-1a) of school / value-cluster / activity
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function hueFrom(s: string): number {
  return fnv1a(s) % 360;
}
function buildGradient(me: Neighborhood, valuesRec: Candidate | undefined): Gradient {
  const seed = fnv1a(me.personId);
  const schoolHue = hueFrom(me.schools[0] ?? me.name);
  const clusterHue = hueFrom(valuesRec?.via ?? me.majors[0] ?? "value");
  const activityHue = hueFrom(me.workingOn[0] ?? me.does[0] ?? me.name);
  return {
    seed,
    stops: [
      { color: `hsl(${schoolHue} 70% 62%)`, at: 0 },
      { color: `hsl(${clusterHue} 65% 55%)`, at: 0.5 },
      { color: `hsl(${activityHue} 72% 48%)`, at: 1 },
    ],
  };
}

// ---------------------------------------------------------------------------
// buildPassport
// ---------------------------------------------------------------------------

export async function buildPassport(personId: string, partyId?: string | null): Promise<Passport> {
  const me = await personNeighborhood(personId);
  if (!me) {
    throw new Error(`[passport] Person ${personId} not found in graph — cannot build a receipted passport (fail-loud).`);
  }

  const line2 = me.companies[0] ?? me.schools[0] ?? "";

  const sw = dedupeCandidates(await sameWorkPath(personId), personId);
  const vp = dedupeCandidates(await valuesPath(personId), personId);
  const sc = dedupeCandidates(await sharedContextPath(personId), personId);

  // rec1 = same-work first (contract), else shared context, else a value connection.
  const rec1 = sw[0] ?? sc[0] ?? vp[0];
  if (!rec1) {
    throw new Error(
      `[passport] No receipted connection for ${personId} (${me.name}) — the graph has no shared work/context/value edge to anchor a find (fail-loud).`,
    );
  }

  // rec2 = values-aligned first, and MUST differ from rec1; else a different context/work connection.
  const rec2 =
    vp.find((c) => c.personId !== rec1.personId) ??
    sc.find((c) => c.personId !== rec1.personId) ??
    sw.find((c) => c.personId !== rec1.personId);
  if (!rec2) {
    throw new Error(
      `[passport] Only one distinct connection for ${personId} (${me.name}); cannot fill two receipted finds (fail-loud).`,
    );
  }

  const [find1, find2, hidden_prompt, magic_inference] = await Promise.all([
    candidateToFind(me, rec1),
    candidateToFind(me, rec2),
    buildHiddenPrompt(personId, partyId),
    buildMagicInference(me, vp[0] ?? sc[0] ?? sw[0]),
  ]);

  const passport: Passport = {
    personId,
    name: me.name,
    line2,
    profile: {
      school: me.schools[0] ?? "",
      major: me.majors[0] ?? "",
      grad_year: me.gradYear,
      position: me.position,
      company: me.companies[0] ?? "",
      belief: me.beliefs[0] ?? "",
      working_on: me.workingOn[0] ?? "",
    },
    find: [find1, find2],
    hidden_prompt,
    magic_inference,
    gradient: buildGradient(me, vp[0]),
  };

  // grounding by construction: an off-shape passport is unrepresentable downstream.
  return passportSchema.parse(passport);
}
