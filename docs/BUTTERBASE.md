# Butterbase runbook — the wire for Ultra Super Party Passport

Everything this app needs from **Butterbase**: the AI gateway (embeddings + chat that
power values-clustering and passport synthesis), and the hosting plane (frontend + the
serverless function the app calls). This is the operator's checklist — exact commands,
exact MCP tool calls, exact strings.

> **Provenance.** Every fact below is sourced from `docs.butterbase.ai` and the
> `github.com/butterbase-ai/butterbase` README, fetched **2026-07-07**. Where the docs
> were silent, the line is marked **[CONFIRM LIVE]** — verify against the running MCP
> server / dashboard before relying on it. Fail loud, don't guess.

---

## 0. What we use Butterbase for (and what we don't)

| Butterbase capability | Do we use it? | Notes |
|---|---|---|
| **AI gateway** (chat + embeddings) | **YES** — core | `lib/gateway.ts`. Powers G3 values embeddings + passport synthesis. |
| **Frontend deployment** | **YES** — ship | Hosts the Next.js app at a live URL (G6). |
| **Serverless function** (`.pipe`) | **YES** — ship | The deployed function the app calls (G6). Butterbase calls these "functions". |
| **Postgres database** | **NO** | Our graph lives in **Neo4j Aura**, not Butterbase Postgres. |
| **Butterbase auth / RLS / storage** | **NO** | Out of scope for the hackathon build. |

The gateway and hosting work **independently** of Butterbase's Postgres — you do not need
a provisioned Butterbase database to call the AI gateway. (docs: core-concepts/database —
"the AI gateway and deployment infrastructure function independently" of the app DB.)

---

## 1. Connect Claude Code to Butterbase (MCP + plugin)

### 1a. The plugin (recommended — MCP + guided skills)

```bash
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills
claude plugin install butterbase
export BUTTERBASE_API_KEY=bb_sk_your_key_here
```

The plugin auto-configures the MCP connection and adds 6 guided skills:

| Skill | Slash command |
|---|---|
| Build App | `/butterbase-skills:build-app` |
| Schema Design | `/butterbase-skills:schema` |
| Deploy Frontend | `/butterbase-skills:deploy` |
| Debug RLS | `/butterbase-skills:debug-rls` |
| Function Dev | `/butterbase-skills:function` |
| Contributing | `/butterbase-skills:contributing` |

Source: `docs.butterbase.ai/sdks-and-tools/plugin` and `/getting-started/mcp-setup`.

### 1b. Manual MCP (if you only want the tools, no skills)

Add to `.mcp.json` (HTTP transport):

```json
{
  "mcpServers": {
    "butterbase": {
      "url": "https://api.butterbase.ai/mcp",
      "headers": { "Authorization": "Bearer ${BUTTERBASE_API_KEY}" }
    }
  }
}
```

Stdio alternative: `npx @butterbase/mcp` (README: "every capability is exposed as MCP
tools at `/mcp`").

### 1c. Get an API key (`bb_sk_...`)

Dashboard → **[dashboard.butterbase.ai](https://dashboard.butterbase.ai)** → **API Keys**
page → "Generate and manage `bb_sk_` API keys for programmatic access." The same key drives
both the MCP server (`Authorization: Bearer`) and the AI gateway (`BUTTERBASE_API_KEY`).

### 1d. Tool discovery — 43 tools, enumerate LIVE

The plugin exposes **43 tools and 1 prompt** (docs: mcp-setup / plugin). There is **no
documented "list all tools" command** — enumerate them **live** from the connected server:

- In Claude Code the tools appear namespaced as **`mcp__butterbase__<tool>`** in the tool
  list; scan that list rather than trusting this doc's subset.
- The named tools we depend on (verify each exists before use):
  `init_app`, `apply_schema`, `execute_sql`, `query`, `deploy_function`,
  `create_frontend_deployment`, `start_frontend_deployment`,
  `prep_and_submit_hackathon_entry`, `generate_service_key`.

**Do not hardcode this list into automation** — the count/names are upstream-owned.

---

## 2. Promo / credit redemption (hackathon)

**[CONFIRM LIVE]** — the docs pages we read (dashboard, before-you-start, hackathon) do
**not** document a dedicated `redeem_promo` MCP tool or a fixed redemption URL. The
standard path, to verify against the live dashboard:

1. Sign in at **[dashboard.butterbase.ai](https://dashboard.butterbase.ai)**.
2. Open **Billing / Credits** (the plan + usage area).
3. **Add promotional credit** → paste the hackathon promo code → apply.

Separately, the **hackathon `submission_code`** (see §5) is what **binds your account as a
participant** — it is required on your *first* submission. Treat the promo code (credits)
and the submission code (participant binding) as two different strings; don't conflate them.

If no redemption UI is present, the credits may be auto-applied to the account tied to your
`bb_sk_` key — confirm your balance in Billing before a long run.

---

## 3. How our app's backend is provisioned

We use **Neo4j Aura** as the graph store (see `.env.example` `NEO4J_*`), so most Butterbase
DB provisioning does **not** apply to us. For completeness (and in case we host the function):

- **App creation:** `butterbase apps create <name>` (CLI) **or** the `init_app` MCP tool →
  returns app credentials + an `app_id` (form `app_...`).
- On app creation Butterbase auto-provisions an isolated Postgres `app_{id}` with pgvector,
  uuid-ossp, and a `current_user_id()` RLS helper (docs: core-concepts/database). **We don't
  use this DB** — it's inert for our build.
- **Schema (if ever needed):** `apply_schema` applies a declarative JSON schema; `execute_sql`
  / `query` for direct SQL. Not used — our schema is the Neo4j ontology in `ontology/manifest.ts`.
- **Auth:** `configure_oauth_provider`, `configure_auth_hook` (docs: core-concepts/authentication).
  Not used.

**What we DO need provisioned:** an `app_id` — because both the function deploy and the
frontend deploy tools take `app_id`, and the hackathon submission uses it for feature scoring.
Get it once via `init_app` and reuse it.

---

## 4. The gateway — how the app calls AI

Wired in **`lib/gateway.ts`** (an `openai` client with `baseURL` swapped to the gateway).

- **Base URL:** env `BUTTERBASE_GATEWAY_URL` = `https://api.butterbase.ai/v1` (OpenAI-compatible;
  app-less `/v1/...` variant — a `bb_sk_` key with the `ai:gateway` scope drives it directly).
- **Auth:** `Authorization: Bearer $BUTTERBASE_API_KEY` (the SDK sets this from `apiKey`).
- **Endpoints the SDK hits:** `POST /v1/chat/completions`, `POST /v1/embeddings`.

### Models (ACTUAL IDs — receipt: core-concepts/ai-integration, 2026-07-07)

**Chat:** `anthropic/claude-sonnet-4.6`, `anthropic/claude-opus-4.6`,
`anthropic/claude-haiku-4.5`, `anthropic/claude-3.7-sonnet`,
`anthropic/claude-3.7-sonnet:thinking`, `openai/gpt-4o`, `openai/gpt-4o-mini`,
`meta-llama/llama-3.3-70b-instruct`, `deepseek/deepseek-r1`, `google/gemini-2.5-flash`.

**Embeddings:** `openai/text-embedding-3-small` (1536d, our default),
`openai/text-embedding-3-large` (3072d), `openai/text-embedding-ada-002` (1536d).

These are exported as `CHAT_MODELS` / `EMBED_MODELS` constants in `lib/gateway.ts`.

### Using it

```ts
import { chat, embed, CHAT_MODELS, DEFAULT_EMBED_MODEL } from '@/lib/gateway';
import { z } from 'zod';

// Embeddings for values clustering (G3) — order-preserving, batched:
const vectors = await embed(['I believe design is a moral act', 'ship fast']);

// Structured chat — zod-guarded, one retry, then loud fail:
const Out = z.object({ name: z.string(), basis: z.string() });
const cluster = await chat(
  CHAT_MODELS.GPT_4O_MINI,
  [{ role: 'user', content: 'Name this value cluster as JSON {name, basis}: ...' }],
  Out, // ← pass a zod schema and you get typed, validated JSON back
);
```

**Degraded mode:** with no creds the module still imports; the first call throws the named
`GatewayNotConfigured` error naming the missing env. No silent fallback, no mock vectors.

---

## 5. Deploy flow → live URL

### 5a. Frontend (the app itself)

Three MCP steps (docs: core-concepts/frontend-deployment):

1. **`create_frontend_deployment({ app_id, framework })`** — `framework: "nextjs-static"`
   for a Next.js static export (or `"react-vite"`). Returns a `deployment_id` and an
   `uploadUrl`.
2. **HTTP `PUT` the zip** to `uploadUrl` — build locally, zip the output, upload. **≤ 100 MB.**
3. **`start_frontend_deployment({ app_id, deployment_id })`** — triggers build + goes live.

**Build → zip (Next.js static export):**
```bash
# next.config.ts must set `output: 'export'` for a static bundle
npm run build            # produces ./out for a static export
cd out && zip -r ../frontend.zip . && cd ..
# then PUT frontend.zip to the uploadUrl from step 1
```

**Live URL format — [CONFIRM LIVE]:** docs describe the default deployment host as
`<name>.pages.dev`, with **`butterbase.dev`** available as a **custom domain** (CNAME, Pro
plan). Our target in the contract is a **`myapp.butterbase.dev`** URL — read the actual host
back from the `start_frontend_deployment` response / the dashboard **Deployments** page and
put the real URL in `SUBMISSION.md`. Do not assume the subdomain; copy what the tool returns.

### 5b. The serverless function (our `.pipe`)

Butterbase calls these **"functions"** (TypeScript/JS on Deno). Our contract calls the
deployed unit a **`.pipe`** — same thing; the deploy tool is:

- **`deploy_function({ name, code, app_id, description?, envVars?, timeoutMs?, triggers?, agent_tool? })`**
  — `code` is the function source with a `default export` handler.
- **Handler shape:**
  ```ts
  export default async function handler(req: Request, ctx: any): Promise<Response> {
    // ctx.env holds encrypted envVars
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  ```
- **The app calls it at:** `ANY https://api.butterbase.ai/v1/{app_id}/fn/{function_name}`
  (end-user tokens are forwarded). Example:
  ```ts
  await fetch(`https://api.butterbase.ai/v1/${appId}/fn/passport-refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ personId }),
  });
  ```

---

## 6. Hackathon submission — the action string

Tool: **`prep_and_submit_hackathon_entry`** (docs: /hackathon). It's a **two-step** flow —
action string **`"prep"`** then action string **`"submit"`**:

1. **`prep`** — resolves the hackathon and returns its `field_schema` (the submission form's
   fields) plus `matched.slug`. Fields are **dynamic per hackathon** — read the schema, don't
   assume `repo`/`url`/`description` keys.
2. **`submit`** — provide:
   - `hackathon_slug` — use **`matched.slug`** from the prep response (targets exactly what
     prep resolved).
   - `data` — an object whose keys match each `field_schema` field's `key` (the real repo
     URL, the live deploy URL from §5a, the description, etc.).
   - `app_id` — **strongly recommended** (links our Butterbase app for automated feature
     scoring).
   - `submission_code` — **required only on the FIRST submission** (binds you as a participant).

Run `prep` first, read the returned `field_schema`, fill `data` to match, then `submit`.
**Deadline: 14:30** (contract G6). Put the live URL + public repo URL into `SUBMISSION.md`
before you submit.

---

## 7. Preflight before submit (fail-loud checklist)

- [ ] `BUTTERBASE_API_KEY` + `BUTTERBASE_GATEWAY_URL` set — `isGatewayConfigured()` true.
- [ ] Promo credits applied (balance > 0 in dashboard Billing). **[CONFIRM LIVE]**
- [ ] `app_id` obtained via `init_app` and reused everywhere.
- [ ] `embed()` returns a 1536-length vector on a smoke string (gateway reachable).
- [ ] Frontend deployed; **live URL copied from the tool response** (not assumed).
- [ ] Function deployed; app calls `…/v1/{app_id}/fn/{name}` successfully.
- [ ] `prep` run; `field_schema` read; `data` matches keys exactly.
- [ ] `submit` with `matched.slug`, `data`, `app_id`, and `submission_code` (first time).
