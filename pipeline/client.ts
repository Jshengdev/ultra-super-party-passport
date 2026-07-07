/**
 * pipeline/client.ts — RocketRide pipeline client for Ultra Super Party Passport.
 *
 * Two inference legs run behind one door (see pipeline/party-passport.pipe):
 *   - "cluster_name"        → name a proto-cluster of beliefs         → { name, basis }
 *   - "passport_inference"  → generate a passport holder's opener     → { hidden_prompt, magic_inference }
 *
 * DUAL PATH (reported as a deviation — see docs/ROCKETRIDE.md):
 *   1. callPipeline(input)      → the deployed RocketRide pipeline over HTTP (ROCKETRIDE_URI + Bearer).
 *   2. callGatewayDirect(input) → the Butterbase OpenAI-compatible gateway, running the SAME leg
 *                                 inline, so the build NEVER blocks on RocketRide creds.
 *   runInference(input)         → tries the pipeline, transparently falls back to the gateway.
 *
 * House rules honored: TS strict, zod at every boundary, fail loud with NAMED errors, a
 * deterministic guard wraps every LLM call (validate shape → reject → retry once → fail loud),
 * DEGRADED mode without creds (a named error that names the missing env; no silent fallback).
 */

import { z } from "zod";
import OpenAI from "openai";

/* ────────────────────────────────────────────────────────────────────────
 * Leg I/O contract (zod = the boundary; an unreceipted value is unrepresentable)
 * ──────────────────────────────────────────────────────────────────────── */

export const ClusterNameInput = z.object({
  leg: z.literal("cluster_name"),
  beliefs: z.array(z.string()).min(1),
});
export type ClusterNameInput = z.infer<typeof ClusterNameInput>;

export const ClusterNameOutput = z.object({
  name: z.string().min(1),
  basis: z.string().min(1),
});
export type ClusterNameOutput = z.infer<typeof ClusterNameOutput>;

export const PassportInferenceInput = z.object({
  leg: z.literal("passport_inference"),
  person: z.object({
    name: z.string(),
    line2: z.string().optional(),
    activities: z.array(z.string()).optional(),
    beliefs: z.array(z.string()).optional(),
    school: z.string().optional(),
    major: z.string().optional(),
  }),
  match: z.object({
    name: z.string(),
    shared: z.string(),
    path_summary: z.string(),
  }),
});
export type PassportInferenceInput = z.infer<typeof PassportInferenceInput>;

export const PassportInferenceOutput = z.object({
  hidden_prompt: z.string().min(1),
  magic_inference: z.string().min(1),
});
export type PassportInferenceOutput = z.infer<typeof PassportInferenceOutput>;

export type PipelineInput = ClusterNameInput | PassportInferenceInput;
export type PipelineOutput = ClusterNameOutput | PassportInferenceOutput;

/** Pick the right output guard for a given leg. */
function outputSchemaFor(input: PipelineInput): z.ZodType<PipelineOutput> {
  return input.leg === "cluster_name"
    ? (ClusterNameOutput as z.ZodType<PipelineOutput>)
    : (PassportInferenceOutput as z.ZodType<PipelineOutput>);
}

/* ────────────────────────────────────────────────────────────────────────
 * Named errors (fail loud — every error names what is missing / what broke)
 * ──────────────────────────────────────────────────────────────────────── */

export class PipelineNotConfigured extends Error {
  constructor(missing: string) {
    super(`PipelineNotConfigured: RocketRide creds missing (${missing}). ` +
      `Set ROCKETRIDE_URI and ROCKETRIDE_APIKEY, or fall back to callGatewayDirect().`);
    this.name = "PipelineNotConfigured";
  }
}

export class GatewayNotConfigured extends Error {
  constructor(missing: string) {
    super(`GatewayNotConfigured: Butterbase gateway creds missing (${missing}). ` +
      `Set BUTTERBASE_API_KEY and BUTTERBASE_GATEWAY_URL.`);
    this.name = "GatewayNotConfigured";
  }
}

export class PipelineInvocationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(`PipelineInvocationError: ${message}`);
    this.name = "PipelineInvocationError";
  }
}

export class InferenceShapeError extends Error {
  constructor(message: string) {
    super(`InferenceShapeError: ${message}`);
    this.name = "InferenceShapeError";
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Deterministic guard: parse the model's raw text into a validated leg output.
 * ──────────────────────────────────────────────────────────────────────── */

/** Pull the first balanced JSON object out of a model reply (tolerates stray prose/fences). */
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new InferenceShapeError(`no JSON object in model reply: ${raw.slice(0, 200)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/** Validate a raw model reply against the leg's output schema. Throws InferenceShapeError. */
function guardOutput(input: PipelineInput, raw: string): PipelineOutput {
  const obj = extractJsonObject(raw);
  const parsed = outputSchemaFor(input).safeParse(obj);
  if (!parsed.success) {
    throw new InferenceShapeError(
      `leg=${input.leg} output failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/* ────────────────────────────────────────────────────────────────────────
 * Path 1 — the deployed RocketRide pipeline (HTTP webhook + Bearer).
 *
 * The engine is normally driven by the `rocketride` SDK over WebSocket
 * (client.use → client.send → client.terminate). That SDK is NOT an installed
 * dependency here and package.json is frozen, so this path speaks to the
 * deployed pipeline's HTTP webhook trigger instead.
 *
 * TODO-verify (against a live cloud deploy — see docs/ROCKETRIDE.md):
 *   - the exact webhook path under ROCKETRIDE_URI (default below is a guess),
 *   - whether the body is the raw job JSON or wrapped as { data, mimetype },
 *   - the exact answers envelope ({ answers } vs { result: { answers } }).
 * Override the path with the optional env ROCKETRIDE_WEBHOOK_PATH.
 * ──────────────────────────────────────────────────────────────────────── */

const DEFAULT_WEBHOOK_PATH = "/v1/pipelines/party-passport/webhook"; // TODO-verify

/** Read the first non-empty string out of RocketRide's answers envelope. */
function firstAnswerText(payload: unknown): string {
  const p = payload as { answers?: unknown; result?: { answers?: unknown } } | null;
  const answers =
    (Array.isArray(p?.answers) && p?.answers) ||
    (Array.isArray(p?.result?.answers) && p?.result?.answers) ||
    null;
  if (answers) {
    for (const a of answers as unknown[]) {
      if (typeof a === "string" && a.trim()) return a;
      if (a && typeof a === "object" && typeof (a as { text?: unknown }).text === "string") {
        const t = (a as { text: string }).text;
        if (t.trim()) return t;
      }
    }
  }
  // A bare-string or {text} response also happens; accept it rather than fail silently.
  if (typeof payload === "string" && payload.trim()) return payload;
  throw new PipelineInvocationError(
    `no answer in pipeline response: ${JSON.stringify(payload).slice(0, 200)}`,
  );
}

export async function callPipeline(input: PipelineInput): Promise<PipelineOutput> {
  PipelineInput_guard(input);
  const uri = process.env.ROCKETRIDE_URI;
  const apikey = process.env.ROCKETRIDE_APIKEY;
  if (!uri) throw new PipelineNotConfigured("ROCKETRIDE_URI");
  if (!apikey) throw new PipelineNotConfigured("ROCKETRIDE_APIKEY");

  const path = process.env.ROCKETRIDE_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;
  const url = new URL(path, uri).toString();
  const body = JSON.stringify(input); // the webhook `text` lane carries the job JSON as text/plain

  const attempt = async (): Promise<PipelineOutput> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apikey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      });
    } catch (e) {
      throw new PipelineInvocationError(`network error calling ${url}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new PipelineInvocationError(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`, res.status);
    }
    const payload: unknown = await res.json().catch(async () => (await res.text()) as unknown);
    return guardOutput(input, firstAnswerText(payload));
  };

  // Deterministic retry-once on a shape failure, then fail loud.
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof InferenceShapeError) return await attempt();
    throw e;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Path 2 — the Butterbase OpenAI-compatible gateway (local fallback).
 *
 * DEVIATION (reported): the contract says "via lib/gateway.ts". That surface is
 * owned by a sibling agent and is not yet present, and its export shape is not
 * pinned in SHAPES. To keep this file self-contained and tsc-green while the
 * build races, callGatewayDirect constructs the SAME OpenAI-compatible client
 * inline from BUTTERBASE_* (identical gateway, identical creds). When
 * lib/gateway.ts lands, swap the two marked lines below for its export.
 * ──────────────────────────────────────────────────────────────────────── */

const SYSTEM_PROMPT =
  "You are the Passport Inference engine for a graph-backed party app. You receive one JSON job " +
  "with a `leg` field and reply with a single raw JSON object — no markdown, no prose. " +
  'For leg "cluster_name" (input { beliefs: string[] }) reply {"name":"<2-4 word Title Case value>","basis":"<one sentence>"}. ' +
  'For leg "passport_inference" (input { person, match }) reply {"hidden_prompt":"<warm 1-2 sentence first-person opener grounded in match.path_summary>","magic_inference":"<one non-obvious delightful sentence one hop beyond the path>"}. ' +
  "Ground every word in the given fields; invent no facts. First character `{`, last character `}`.";

function gatewayModel(): string {
  // TODO-verify the Butterbase model catalog; overridable via ROCKETRIDE_FALLBACK_MODEL.
  return process.env.ROCKETRIDE_FALLBACK_MODEL || "gpt-4o-mini";
}

function makeGatewayClient(): OpenAI {
  const apiKey = process.env.BUTTERBASE_API_KEY;
  const baseURL = process.env.BUTTERBASE_GATEWAY_URL;
  if (!apiKey) throw new GatewayNotConfigured("BUTTERBASE_API_KEY");
  if (!baseURL) throw new GatewayNotConfigured("BUTTERBASE_GATEWAY_URL");
  // ── swap point: when lib/gateway.ts is finalized, replace these two lines with its client ──
  return new OpenAI({ apiKey, baseURL });
}

export async function callGatewayDirect(input: PipelineInput): Promise<PipelineOutput> {
  PipelineInput_guard(input);
  const client = makeGatewayClient();

  const run = async (): Promise<PipelineOutput> => {
    const completion = await client.chat.completions.create({
      model: gatewayModel(),
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    return guardOutput(input, raw);
  };

  // Deterministic guard: validate → reject → retry once → fail loud.
  try {
    return await run();
  } catch (e) {
    if (e instanceof InferenceShapeError) return await run();
    if (e instanceof GatewayNotConfigured || e instanceof InferenceShapeError) throw e;
    throw new PipelineInvocationError(`gateway call failed: ${(e as Error).message}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Convenience — try the pipeline, fall back to the gateway. Never blocks.
 * ──────────────────────────────────────────────────────────────────────── */

export async function runInference(input: PipelineInput): Promise<PipelineOutput> {
  try {
    return await callPipeline(input);
  } catch (e) {
    // Fall back only when RocketRide is unconfigured or unreachable — never to hide a real shape bug.
    if (e instanceof PipelineNotConfigured || e instanceof PipelineInvocationError) {
      return await callGatewayDirect(input);
    }
    throw e;
  }
}

/* Validate untrusted callers' input at the boundary (both paths share this). */
function PipelineInput_guard(input: PipelineInput): void {
  const schema =
    input && (input as PipelineInput).leg === "cluster_name" ? ClusterNameInput : PassportInferenceInput;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InferenceShapeError(`invalid pipeline input: ${parsed.error.message}`);
  }
}
