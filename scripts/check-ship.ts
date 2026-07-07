/**
 * scripts/check-ship.ts — the G6 ship checklist (contract: gx/goals/usp-v1.md).
 *
 * Honest-fail gate. Every ship-critical item is a named check that can and MUST be
 * able to FAIL (sayhello fail-closed law): the gate stays red until the thing is
 * really true, so `npm run verify:goal ship` cannot go green on a promise.
 *
 * Checks:
 *   1. submission          — docs/SUBMISSION.md exists + every required section present
 *   2. readme-ai-disclosure — README.md exists + carries the AI-disclosure section
 *   3. pipe                — a deployed inference artifact exists (pipeline/ *.pipe)
 *   4. passports           — data/passports/ is non-empty (>=1 <personId>.json)
 *   5. live-url            — a LIVE_URL env var is set AND the URL returns HTTP 200
 *
 * Exit code: 0 iff ALL required checks pass; 1 otherwise. Every failure prints a
 * NAMED line saying exactly what is missing (fail loud). Pass `--soft` to print the
 * report and always exit 0 (for a non-gating status glance).
 *
 * Run: `npx tsx scripts/check-ship.ts`  (or `npm run verify:goal ship`).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve everything from the repo root, not the caller's cwd, so the checker is
// correct no matter where it is invoked from.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel: string): string => resolve(REPO_ROOT, rel);

/** Env var names that may carry the deployed URL (any one satisfies live-url). */
const LIVE_URL_ENV_KEYS = ['LIVE_URL', 'NEXT_PUBLIC_LIVE_URL', 'BUTTERBASE_LIVE_URL'] as const;

/** Required H2 sections in docs/SUBMISSION.md (matched case-insensitively). */
const SUBMISSION_SECTIONS: readonly string[] = [
  'Problem',
  'The graph model',
  'How Butterbase is integrated',
  'How RocketRide is integrated',
  'Bonus integrations',
  'Team',
  'Repository',
];

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function readIfExists(absPath: string): string | null {
  return existsSync(absPath) ? readFileSync(absPath, 'utf8') : null;
}

/** True if the markdown has an H2 (##) heading whose text contains `section`. */
function hasSection(md: string, section: string): boolean {
  const re = new RegExp(`^#{1,3}\\s+.*${escapeRe(section)}`, 'im');
  return re.test(md);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstLiveUrl(): { key: string; url: string } | null {
  for (const key of LIVE_URL_ENV_KEYS) {
    const url = process.env[key]?.trim();
    if (url) return { key, url };
  }
  return null;
}

async function fetch200(url: string, timeoutMs = 6000): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (res.status === 200) return { ok: true, detail: `HTTP 200 from ${url}` };
    return { ok: false, detail: `${url} returned HTTP ${res.status} (want 200)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `fetch to ${url} failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

function checkSubmission(): CheckResult {
  const md = readIfExists(p('docs/SUBMISSION.md'));
  if (md === null) return { name: 'submission', ok: false, detail: 'docs/SUBMISSION.md is missing' };
  const missing = SUBMISSION_SECTIONS.filter((s) => !hasSection(md, s));
  if (missing.length > 0) {
    return { name: 'submission', ok: false, detail: `SUBMISSION.md missing section(s): ${missing.join(', ')}` };
  }
  return { name: 'submission', ok: true, detail: `all ${SUBMISSION_SECTIONS.length} required sections present` };
}

function checkReadmeAiDisclosure(): CheckResult {
  const md = readIfExists(p('README.md'));
  if (md === null) return { name: 'readme-ai-disclosure', ok: false, detail: 'README.md is missing' };
  if (!hasSection(md, 'AI disclosure')) {
    return { name: 'readme-ai-disclosure', ok: false, detail: 'README.md has no "AI disclosure" section' };
  }
  return { name: 'readme-ai-disclosure', ok: true, detail: 'AI-disclosure section present' };
}

function checkPipe(): CheckResult {
  const dir = p('pipeline');
  if (!existsSync(dir)) return { name: 'pipe', ok: false, detail: 'pipeline/ directory is missing' };
  const pipes = readdirSync(dir).filter((f) => f.endsWith('.pipe'));
  if (pipes.length === 0) {
    return { name: 'pipe', ok: false, detail: 'no *.pipe file in pipeline/ (RocketRide inference artifact)' };
  }
  return { name: 'pipe', ok: true, detail: `found ${pipes.length} pipe(s): ${pipes.join(', ')}` };
}

function checkPassports(): CheckResult {
  const dir = p('data/passports');
  if (!existsSync(dir)) return { name: 'passports', ok: false, detail: 'data/passports/ directory is missing' };
  const jsons = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (jsons.length === 0) {
    return { name: 'passports', ok: false, detail: 'data/passports/ is empty (no <personId>.json)' };
  }
  return { name: 'passports', ok: true, detail: `${jsons.length} passport(s) generated` };
}

async function checkLiveUrl(): Promise<CheckResult> {
  const found = firstLiveUrl();
  if (!found) {
    return {
      name: 'live-url',
      ok: false,
      detail: `no live URL set — set one of ${LIVE_URL_ENV_KEYS.join(' / ')} to the deployed URL`,
    };
  }
  const { key, url } = found;
  const res = await fetch200(url);
  return { name: 'live-url', ok: res.ok, detail: `${key}=${url} — ${res.detail}` };
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const soft = process.argv.includes('--soft');

  const results: CheckResult[] = [
    checkSubmission(),
    checkReadmeAiDisclosure(),
    checkPipe(),
    checkPassports(),
    await checkLiveUrl(),
  ];

  console.log('\n  SHIP CHECKLIST (G6 · gx/goals/usp-v1.md)\n');
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.name.padEnd(20)} ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;
  console.log(`\n  ${passed}/${results.length} checks passed.`);

  if (failed.length > 0) {
    console.log(`  NOT SHIPPABLE — unmet: ${failed.map((f) => f.name).join(', ')}\n`);
    if (!soft) process.exit(1);
    return;
  }
  console.log('  ALL CLEAR — shippable.\n');
}

main().catch((err) => {
  // Any unexpected throw is itself a failure of the gate — fail loud.
  console.error('check-ship crashed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
