/**
 * lib/gateway.ts — the Butterbase wire.
 *
 * A thin, OpenAI-compatible client factory pointed at the Butterbase AI gateway.
 * Butterbase exposes an OpenAI-shaped API (`/v1/chat/completions`, `/v1/embeddings`)
 * so we drive it with the stock `openai` npm package by swapping the `baseURL`.
 *
 * Design contract (SHAPES + HOUSE RULES):
 *   - Reads creds from process.env ONLY (BUTTERBASE_GATEWAY_URL / BUTTERBASE_API_KEY).
 *     NEVER hardcodes a key or URL.
 *   - DEGRADED mode: if a cred is missing, the MODULE still imports fine; the first
 *     call throws the named `GatewayNotConfigured` error naming the missing env.
 *     Fail loud — no silent fallback, no mock embeddings.
 *   - Deterministic guard around every LLM call: when a zod `schema` is passed to
 *     `chat()`, the model output is JSON-parsed + schema-validated; on failure we
 *     retry ONCE (with a corrective nudge), then fail loud with `GatewaySchemaError`.
 *   - Transient API/network errors also get exactly one retry, then `GatewayError`.
 *
 * Shared surface: `chat`, `embed`, the model constants, the error classes, and the
 * `ChatMessage` type are the declared imports other agents may use. Keep them stable.
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Model catalog — ACTUAL gateway model IDs.
// RECEIPT: docs.butterbase.ai/core-concepts/ai-integration — "Available Models"
// table, fetched 2026-07-07. These are the exact `provider/model` strings the
// gateway routes. Do not invent variants; if the gateway 404s a model, it was
// removed upstream — check the live docs, don't guess.
// ---------------------------------------------------------------------------

/** Chat / completion models routable through the gateway. */
export const CHAT_MODELS = {
  // Anthropic
  CLAUDE_SONNET: 'anthropic/claude-sonnet-4.6',
  CLAUDE_OPUS: 'anthropic/claude-opus-4.6',
  CLAUDE_HAIKU: 'anthropic/claude-haiku-4.5',
  CLAUDE_37_SONNET: 'anthropic/claude-3.7-sonnet',
  CLAUDE_37_SONNET_THINKING: 'anthropic/claude-3.7-sonnet:thinking',
  // OpenAI
  GPT_4O: 'openai/gpt-4o',
  GPT_4O_MINI: 'openai/gpt-4o-mini',
  // Others
  LLAMA_33_70B: 'meta-llama/llama-3.3-70b-instruct',
  DEEPSEEK_R1: 'deepseek/deepseek-r1',
  GEMINI_25_FLASH: 'google/gemini-2.5-flash',
} as const;

/**
 * Embedding models. RECEIPT: same page, "Embedding Models" list. Dimensions are
 * documented inline so downstream clustering code (G3) can size its vectors.
 */
export const EMBED_MODELS = {
  // Verified live against GET /v1/models on the Butterbase gateway (2026-07-07): only these
  // three embedding models exist; the openai/text-embedding-3-* family 404s.
  TEXT_EMBEDDING_004: 'openai/text-embedding-004',
  GEMINI_EMBEDDING_001: 'google/gemini-embedding-001',
  TITAN_EMBED_V2: 'amazon/amazon.titan-embed-text-v2:0'
} as const;

/** Dimensions per embedding model — for sizing / assertion by callers. */
export const EMBED_DIMENSIONS: Record<string, number> = {
  [EMBED_MODELS.TEXT_EMBEDDING_004]: 1536,
  [EMBED_MODELS.GEMINI_EMBEDDING_001]: 3072,
  [EMBED_MODELS.TITAN_EMBED_V2]: 1024,
};

/**
 * Sensible defaults. Training-density corollary: pick the boring, most-standard
 * pieces. `gpt-4o-mini` is cheap+fast for structured extraction; the small
 * embedding model is the OpenAI-compatible default everyone tests against.
 */
export const DEFAULT_CHAT_MODEL: string = CHAT_MODELS.GPT_4O_MINI;
export const DEFAULT_EMBED_MODEL: string = process.env.BUTTERBASE_EMBED_MODEL || EMBED_MODELS.TEXT_EMBEDDING_004;
export const DEFAULT_EMBED_DIM: number = EMBED_DIMENSIONS[DEFAULT_EMBED_MODEL];

// ---------------------------------------------------------------------------
// Errors — named + loud. Callers can `instanceof` to distinguish degraded-mode
// (fix your env) from a genuine upstream failure (retry/backoff).
// ---------------------------------------------------------------------------

/** Missing/blank creds. Degraded mode — the app can boot, but no gateway call works. */
export class GatewayNotConfigured extends Error {
  constructor(missing: string) {
    super(
      `Butterbase gateway not configured: missing env ${missing}. ` +
        `Set BUTTERBASE_GATEWAY_URL and BUTTERBASE_API_KEY (see .env.example). ` +
        `Running in DEGRADED mode — no AI calls possible.`,
    );
    this.name = 'GatewayNotConfigured';
  }
}

/** Transport/API failure that survived our one retry. */
export class GatewayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatewayError';
  }
}

/** Model output failed JSON parse or zod validation on both attempts. */
export class GatewaySchemaError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatewaySchemaError';
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// Client factory (lazy — so importing this module in degraded mode is safe).
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;

/**
 * Build (once) an OpenAI-compatible client aimed at the Butterbase gateway.
 * baseURL = env BUTTERBASE_GATEWAY_URL (e.g. https://api.butterbase.ai/v1),
 * apiKey  = env BUTTERBASE_API_KEY (bb_sk_...). The SDK appends
 * `/chat/completions` and `/embeddings` to the baseURL — matching the gateway's
 * app-less `/v1/...` variant, which a personal `bb_sk_` key with the `ai:gateway`
 * scope can drive directly (docs: core-concepts/ai-integration, Authentication).
 *
 * @throws GatewayNotConfigured when either env var is absent/blank.
 */
export function getGatewayClient(): OpenAI {
  if (_client) return _client;

  const baseURL = process.env.BUTTERBASE_GATEWAY_URL?.trim();
  const apiKey = process.env.BUTTERBASE_API_KEY?.trim();

  if (!baseURL) throw new GatewayNotConfigured('BUTTERBASE_GATEWAY_URL');
  if (!apiKey) throw new GatewayNotConfigured('BUTTERBASE_API_KEY');

  _client = new OpenAI({ baseURL, apiKey });
  return _client;
}

/** True when both creds are present. Lets callers branch into DEGRADED UI cleanly. */
export function isGatewayConfigured(): boolean {
  return Boolean(
    process.env.BUTTERBASE_GATEWAY_URL?.trim() && process.env.BUTTERBASE_API_KEY?.trim(),
  );
}

// ---------------------------------------------------------------------------
// Public message shape (kept minimal + OpenAI-assignable).
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// ---------------------------------------------------------------------------
// chat() — one call, deterministic guard, one retry, loud fail.
// ---------------------------------------------------------------------------

const DEFAULT_TEMPERATURE = 0.3;
const MAX_ATTEMPTS = 2; // initial + one retry (HOUSE RULE: "retry once, then fail loud")

/** Strip a ```json ... ``` (or bare ```) code fence some models wrap JSON in. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Chat with no schema — returns the raw assistant text. */
export function chat(model: string, messages: ChatMessage[]): Promise<string>;
/** Chat with a zod schema — returns validated, typed JSON. */
export function chat<T>(
  model: string,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
): Promise<T>;
export async function chat<T>(
  model: string,
  messages: ChatMessage[],
  schema?: z.ZodType<T>,
): Promise<T | string> {
  const client = getGatewayClient();
  const wantJson = Boolean(schema);

  // Working copy of the conversation; a failed structured attempt appends a
  // corrective turn so the retry is actually informed, not a blind re-roll.
  const convo: ChatMessage[] = messages.slice();

  let lastRaw = '';
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let content: string;
    try {
      const res = await client.chat.completions.create({
        model,
        messages: convo as ChatCompletionMessageParam[],
        temperature: DEFAULT_TEMPERATURE,
        ...(wantJson ? { response_format: { type: 'json_object' as const } } : {}),
      });
      content = res.choices[0]?.message?.content ?? '';
    } catch (err) {
      // Transport/API error — retry once, then fail loud.
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) continue;
      throw new GatewayError(
        `Butterbase chat call failed after ${MAX_ATTEMPTS} attempt(s) for model "${model}": ${errMsg(err)}`,
        { cause: err },
      );
    }

    lastRaw = content;

    // No schema requested → the string IS the deliverable.
    if (!schema) return content;

    // Deterministic guard: parse + validate. On failure, nudge and retry once.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(content));
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        convo.push({ role: 'assistant', content });
        convo.push({
          role: 'user',
          content:
            'That was not valid JSON. Respond with ONLY a single valid JSON object, no prose, no code fences.',
        });
        continue;
      }
      throw new GatewaySchemaError(
        `Butterbase chat returned non-JSON for model "${model}" after ${MAX_ATTEMPTS} attempt(s).`,
        content,
        { cause: err },
      );
    }

    const check = schema.safeParse(parsed);
    if (check.success) return check.data;

    lastErr = check.error;
    if (attempt < MAX_ATTEMPTS) {
      convo.push({ role: 'assistant', content });
      convo.push({
        role: 'user',
        content:
          'Your JSON did not match the required schema. Fix these issues and return ONLY the corrected JSON object:\n' +
          check.error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'),
      });
      continue;
    }
    throw new GatewaySchemaError(
      `Butterbase chat output failed schema validation for model "${model}" after ${MAX_ATTEMPTS} attempt(s): ${check.error.message}`,
      content,
      { cause: check.error },
    );
  }

  // Unreachable (loop either returns or throws), but keeps the type-checker + the
  // fail-loud law honest if the constant is ever miscofigured.
  throw new GatewayError(
    `Butterbase chat exhausted all attempts for model "${model}": ${errMsg(lastErr)}`,
    { cause: lastErr },
  );
}

// ---------------------------------------------------------------------------
// embed() — batched embeddings, one retry, loud fail. Returns vectors in the
// SAME ORDER as the input texts.
// ---------------------------------------------------------------------------

/**
 * Embed a batch of texts. Uses DEFAULT_EMBED_MODEL (text-embedding-3-small, 1536d).
 * Empty input → []. Order is preserved (results are re-sorted by the API `index`).
 *
 * @throws GatewayNotConfigured in degraded mode; GatewayError after one failed retry.
 */
export async function embed(
  texts: string[],
  model: string = DEFAULT_EMBED_MODEL,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = getGatewayClient();

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await client.embeddings.create({ model, input: texts });
      // Guard: the gateway must return one vector per input, in order.
      if (res.data.length !== texts.length) {
        throw new GatewayError(
          `Embedding count mismatch for model "${model}": got ${res.data.length}, expected ${texts.length}.`,
        );
      }
      return res.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding as number[]);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) continue;
      throw new GatewayError(
        `Butterbase embed call failed after ${MAX_ATTEMPTS} attempt(s) for model "${model}": ${errMsg(err)}`,
        { cause: err },
      );
    }
  }
  throw new GatewayError(
    `Butterbase embed exhausted all attempts for model "${model}": ${errMsg(lastErr)}`,
    { cause: lastErr },
  );
}

// ---------------------------------------------------------------------------
// Small util.
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}
