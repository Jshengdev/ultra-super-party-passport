# RocketRide — deploy & smoke-test runbook

The inference pipeline for Ultra Super Party Passport. One webhook door, one reasoning
agent, two legs. This is the runbook to edit it, deploy it, and prove the endpoint is live.

- Pipeline: [`pipeline/party-passport.pipe`](../pipeline/party-passport.pipe)
- Client:   [`pipeline/client.ts`](../pipeline/client.ts)
- Engine studied: `rocketride-server` **v3.1.2** (from `rocketride-org/rocketride-workshops`)

---

## What the pipeline does

```
                                              ┌───────────────────────┐
 webhook_1 ── text ── question_1 ── questions ┤   agent_passport      ├─ answers ─ response_answers_1
 (Source)            (normalizer)             │  (agent_deepagent)    │            (Return Answers)
                                              └───────────┬───────────┘
                                                   llm (control)
                                                          │
                                              llm_anthropic_passport
                                              (claude-sonnet-4-6)
```

One HTTP job in, one JSON answer out. The agent's `system_prompt` (baked into the `.pipe`)
routes on the job's `leg` field:

| leg                   | input                                   | output                                  |
| --------------------- | --------------------------------------- | --------------------------------------- |
| `cluster_name`        | `{ beliefs: string[] }`                 | `{ name, basis }`                       |
| `passport_inference`  | `{ person, match }` (real graph path)   | `{ hidden_prompt, magic_inference }`    |

The LLM is a **control-brain of the agent** (`control: [{ classType: "llm", from: "agent_passport" }]`),
which is the pattern the real RocketRide workshop pipes use — the LLM node itself carries no
prompt; the inference logic lives in the agent's `system_prompt`.

---

## Prerequisites

- **Node.js ≥ 20**, **pnpm ≥ 9** (matches the RocketRide workshop toolchain).
- VS Code (or a fork: Cursor / Windsurf / VSCodium — the extension ships on Open VSX too).
- A RocketRide account for cloud deploy (`cloud.rocketride.ai`).

---

## 1. Edit the pipeline in RocketRide Studio (VS Code extension)

1. **Install the extension.** In VS Code, open the Extensions panel and search **RocketRide**.
   Install it. (Forks: install from the Open VSX Registry.)
2. **Open the runtime panel.** Click the RocketRide icon in the sidebar. Pick a deploy target:
   - **Local (recommended for dev)** — runs the engine inside your IDE.
   - **On-premises** — Docker or source build.
   - **RocketRide Cloud** — the managed target (see §3).
3. **Open the pipeline.** Open `pipeline/party-passport.pipe`. The extension auto-opens it in
   the **visual builder** (the file is JSON underneath — you rarely edit it by hand).
4. **Wire check.** You should see five nodes: `Party Webhook → Job Normalizer → Passport
   Inference → Return Answers`, with `Anthropic Passport` attached to the agent as its LLM.
5. **Set the model key.** On the `Anthropic Passport` node, the API key field references
   `${ROCKETRIDE_ANTHROPIC_KEY}`. Provide that secret to the runtime (see §4).
6. **Run locally.** Press **Run** on the source node (or use the **Connection Manager** panel).
   Send a test job through the built-in form / chat, and watch the call tree, token usage, and
   the `answers` output stream back. Save the `.pipe` to keep any Studio edits.

> **Editing by hand:** almost never. Studio owns node positions, lane wiring, and config.
> The only fields worth hand-editing are the `system_prompt` strings (Studio also saves those
> into the JSON). If a `.pipe` git diff is only `ui.position` / `docRevision`, that's just
> Studio rearranging the canvas — safe to commit.

---

## 2. Invocation model (how a client talks to a deployed pipeline)

The **canonical** transport is the RocketRide SDK (`rocketride` on npm / PyPI) over WebSocket:

```ts
// canonical SDK shape (NOT used here — see the note below)
import { RocketRideClient } from "rocketride";
const client = new RocketRideClient({ auth: process.env.ROCKETRIDE_APIKEY!, uri: "https://api.rocketride.ai" });
await client.connect();
const { token } = await client.use({ filepath: "./pipeline/party-passport.pipe", source: "webhook_1" });
const result = await client.send(token, JSON.stringify(job), { name: "job.json" }, "text/plain");
await client.terminate(token);
```

**Why our `client.ts` does NOT use the SDK:** the `rocketride` package is not an installed
dependency of this repo and `package.json` is frozen. So `pipeline/client.ts` talks to the
deployed pipeline's **HTTP webhook trigger** instead (`callPipeline`), and carries a Butterbase
gateway fallback (`callGatewayDirect`) so the app never blocks on RocketRide creds. See
[`pipeline/client.ts`](../pipeline/client.ts).

### ⚠️ TODO-verify against a live deploy

The docs pin the SDK/WebSocket path precisely but do **not** publish the HTTP webhook contract.
Confirm these three against your actual deployed endpoint and adjust `client.ts` if needed:

1. **Webhook path** under `ROCKETRIDE_URI`. `client.ts` defaults to
   `/v1/pipelines/party-passport/webhook` and honors an override env `ROCKETRIDE_WEBHOOK_PATH`.
2. **Request body** — whether the trigger wants the raw job JSON (what we send) or a wrapper
   like `{ "data": "<job json>", "mimetype": "text/plain" }`.
3. **Answer envelope** — `client.ts` reads both `{ answers: [...] }` and
   `{ result: { answers: [...] } }` (the two shapes the SDK has used) and a bare string.

If the cloud only exposes the WebSocket transport, install the `rocketride` SDK (needs a
`package.json` change — out of this fence) and route `callPipeline` through `client.use/send`.

---

## 3. Deploy to RocketRide Cloud

1. Sign in at **`cloud.rocketride.ai`**. The cloud API host is **`https://api.rocketride.ai`**
   (this is `ROCKETRIDE_URI`). Always use `https://` / `wss://` for Cloud — plaintext silently
   downgrades.
2. From the RocketRide sidebar in VS Code, choose **RocketRide Cloud** as the deploy target for
   `party-passport.pipe` (or push it from the cloud console's pipeline import).
3. **Create an API key** in the cloud console → **API Keys**. Copy it into `.env` as
   `ROCKETRIDE_APIKEY` (the client sends it as `Authorization: Bearer <key>`).
4. **Set the pipeline-side model secret.** In the cloud project's environment / secrets, set
   `ROCKETRIDE_ANTHROPIC_KEY` — the `Anthropic Passport` node reads it via `${ROCKETRIDE_ANTHROPIC_KEY}`.
5. Deploy. Note the pipeline id / webhook path the console gives you and reconcile it with
   `ROCKETRIDE_WEBHOOK_PATH` (§2, TODO-verify #1).

---

## 4. Environment

Copy `.env.example` → `.env` and fill in. Relevant to RocketRide:

| Env                        | Where used                        | Notes                                             |
| -------------------------- | --------------------------------- | ------------------------------------------------- |
| `ROCKETRIDE_URI`           | `client.ts` (`callPipeline`)      | `https://api.rocketride.ai`                        |
| `ROCKETRIDE_APIKEY`        | `client.ts` (Bearer)              | cloud console → API Keys                           |
| `ROCKETRIDE_WEBHOOK_PATH`  | `client.ts` (optional override)   | default `/v1/pipelines/party-passport/webhook`     |
| `ROCKETRIDE_ANTHROPIC_KEY` | the `.pipe` LLM node (cloud-side) | set in the RocketRide project, NOT read by our app |
| `BUTTERBASE_API_KEY`       | `client.ts` (`callGatewayDirect`) | fallback path                                      |
| `BUTTERBASE_GATEWAY_URL`   | `client.ts` (`callGatewayDirect`) | `https://api.butterbase.ai/v1`                      |
| `ROCKETRIDE_FALLBACK_MODEL`| `client.ts` (optional)            | default `gpt-4o-mini` — TODO-verify Butterbase catalog |

Without RocketRide creds, `callPipeline` throws the named `PipelineNotConfigured` (fail loud);
`runInference` then degrades to `callGatewayDirect`. Without Butterbase creds too, the gateway
throws `GatewayNotConfigured`. Nothing fails silently.

---

## 5. Verify the endpoint (smoke tests)

### 5a. From the app / a script

```ts
import { runInference } from "@/pipeline/client";

console.log(await runInference({ leg: "cluster_name", beliefs: [
  "You should build in public and share the messy middle.",
  "Working with the garage door up beats a big reveal.",
] }));
// → { name: "Build In Public", basis: "..." }
```

### 5b. Exact curl (HTTP webhook trigger)

Replace `$ROCKETRIDE_URI`, `$ROCKETRIDE_APIKEY`, and the path if the console gave you a
different one. This is the request `callPipeline` makes.

```sh
curl -sS -X POST "$ROCKETRIDE_URI/v1/pipelines/party-passport/webhook" \
  -H "Authorization: Bearer $ROCKETRIDE_APIKEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "leg": "passport_inference",
    "person": { "name": "Ada", "line2": "MIT · CS", "activities": ["improv","climbing"],
                "beliefs": ["ship the messy middle"], "school": "MIT", "major": "CS" },
    "match": { "name": "Ben", "shared": "both do improv; both value building in public",
               "path_summary": "Ada DOES improv; Ben DOES improv; both BELIEVES in-cluster Build In Public" }
  }'
```

**Expected:** HTTP 200 with an answers envelope whose first answer is a raw JSON string, e.g.
`{"hidden_prompt":"Hey Ben — heard you do improv too...","magic_inference":"..."}`.

**Reading the result:** `client.ts`'s `firstAnswerText()` unwraps `{ answers: [...] }`,
`{ result: { answers: [...] } }`, or a bare string, then the deterministic guard
(`guardOutput`) validates the JSON against the leg's zod schema and retries once before
failing loud with `InferenceShapeError`.

### 5c. Fallback smoke test (no RocketRide creds)

With only `BUTTERBASE_*` set, `runInference` skips the pipeline and runs the same leg through
the gateway — good for local dev before the cloud deploy exists.

---

## 6. Failure modes (all loud, all named)

| Error                     | Cause                                              |
| ------------------------- | -------------------------------------------------- |
| `PipelineNotConfigured`   | `ROCKETRIDE_URI` or `ROCKETRIDE_APIKEY` missing    |
| `PipelineInvocationError` | non-2xx HTTP, network error, or empty answer       |
| `GatewayNotConfigured`    | `BUTTERBASE_API_KEY` / `BUTTERBASE_GATEWAY_URL` missing |
| `InferenceShapeError`     | model reply isn't valid JSON for the leg (after one retry) |

---

## Appendix — pipeline node reference (verbatim shapes)

Sourced from real `.pipe` files in `rocketride-org/rocketride-workshops`
(`workshops/coding-agent/solution/api/app/pipelines/`).

- **`webhook`** (source): `config: { hideForm, mode: "Source", parameters: {}, type: "webhook", name }`.
  Emits a `text` lane for `text/plain` input (also `image`/`audio` by mimetype — unused here).
- **`question`** (normalizer): `config: { type: "question", name }`. Takes `text` lanes, emits `questions`.
- **`agent_deepagent`**: `config: { profile: "default", default: { advanced_mode, agent_description,
  system_prompt }, name }`. Input lane `questions`, output lane `answers`. Our agent uses no tools
  and never delegates — a pure reasoner. TODO-verify: if the engine requires a deepagent to have at
  least one tool/subagent, the alternative is a standalone `llm_anthropic`/`llm_openai` node fed by a
  prompt-building node (the pattern the docs' RAG example shows), with the prompt supplied as input.
- **`llm_anthropic`**: `config: { profile: "claude-sonnet-4-6", "claude-sonnet-4-6": { modelSource:
  "manual", apikey: "${ROCKETRIDE_ANTHROPIC_KEY}" }, name }`. Attached as a control-brain via
  `control: [{ classType: "llm", from: "<agent id>" }]`. Env interpolation uses `${VAR}`.
- **`response_answers`**: `config: { laneName: "answers", name }`. Input lane `answers`.

## Live deploy probe (2026-07-07, ~13:15 PDT)

**DEPLOYED: YES (resident on cloud), one cloud-side secret short of end-to-end.**

- SDK: `pip install rocketride` (v1.3.0, **fully async** — every call must be awaited).
- Working sequence (verified live):
  ```python
  c = RocketRideClient(uri="https://api.rocketride.ai", auth=ROCKETRIDE_APIKEY)
  await c.connect()                      # returns account identity (johnny sheng)
  rec = await c.deploy.add(pipeline=json.load(open("party-passport.pipe")))
  #   -> DeploymentRecord project_id 00000000-0000-4000-8000-partypassport1, ACTIVATED
  await c.deploy.list()                  # shows the pipeline resident
  ```
- **Invocation contract (verified):** HTTP `POST /task/data` requires a **TASK TOKEN as the
  Bearer** (the API key is NOT accepted; same error pre/post deploy). The token is minted by
  `await c.use(name=..., use_existing=True, ...)` over the SDK's WS/DAP session; then
  `await c.send(token, data, {"name":"job.json"}, "application/json")` runs the job — or plain
  HTTP with `Authorization: Bearer <task-token>`.
- **The one blocker to end-to-end:** the pipe's `llm_anthropic` brain resolves
  `${ROCKETRIDE_ANTHROPIC_KEY}` cloud-side; `use()` errors `Invalid Anthropic API key format`.
  No Anthropic key exists in any local env. FIXES (either): (a) Johnny sets
  `ROCKETRIDE_ANTHROPIC_KEY` in RocketRide cloud project settings (dashboard) or hands any
  Anthropic key → pass via `use(env={...})`; (b) swap the brain node to an OpenAI-compatible
  provider pointed at the Butterbase gateway — BLOCKED on schema receipts (no llm_openai
  example exists in the workshops repo; guessing config fields is a demo-time risk).
- **What pipeline/client.ts needs (do not guess-edit):** callPipeline's Bearer must be a task
  token, not the API key; token-minting needs the SDK (WS), so either mint a long-TTL token at
  deploy time and ship it as ROCKETRIDE_TASK_TOKEN env, or keep runInference's gateway
  fallback as the app path until the cloud key lands. `use(ttl=...)` exists in the SDK
  signature — untested.
