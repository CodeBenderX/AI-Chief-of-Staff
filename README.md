# AI Company Operating System

A platform for running a company with an AI workforce and a human CEO. You brief the company in one place; the AI Chief of Staff plans the work, delegates it to department agents, runs it under hard limits, pauses for your approval before anything external or irreversible happens, and reports back.

Status: **milestone 1, working core slice.** See [What works today](#what-works-today) and [Not built yet](#not-built-yet) for an exact account.

## Quick start (local)

Requirements: Node 22+, pnpm 10+. PostgreSQL 16 is recommended; without it the app uses an embedded Postgres (PGlite) in `./data`.

```bash
pnpm install
cp .env.example .env            # set JWT_SECRET and MASTER_KEY (commands are in the file)
pnpm --filter @aicos/core build
pnpm --filter @aicos/web build
set -a; . ./.env; set +a
pnpm dev:api                    # http://127.0.0.1:8787, serves the dashboard too
```

Open http://127.0.0.1:8787 and create the CEO account (first run only). For UI development, run `pnpm dev:web` too and use http://localhost:5173 (it proxies `/api`).

### Using your local models (Ollama / LM Studio)

The default model profile points at Ollama on `http://localhost:11434/v1` with `llama3.1:8b`.

1. `ollama pull llama3.1:8b` (or any model with tool calling) and make sure Ollama is running.
2. In **Settings → AI models**, set the model name on the `default` and `planner` profiles to the model you pulled. For LM Studio, enable the `lmstudio` provider (`http://localhost:1234/v1`) and point profiles at it.

If no model is reachable, every profile falls back to `offline`, a deterministic mock, so the product still works end to end and says so in its output. Small local models follow the JSON planning format less reliably than large hosted models; invalid plans are rejected and retried, then the Chief of Staff handles the objective directly.

To use Claude or OpenAI, add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in **Settings → API keys** and switch agent profiles to `claude` or `gpt`. Check the per-token prices in Settings against the provider's current price list; they drive cost tracking and budgets.

### Connecting email

Approved emails are delivered over SMTP from an account you choose. Until you connect one, they wait in the **Outbox** marked "not sent", and you can send them later with one click.

1. In **Settings → Email**, pick your provider to fill in the server, port and encryption, or enter them yourself.
2. Enter the username, password, from address and from name.
   - **Gmail / Google Workspace:** turn on 2-Step Verification, then create an *app password* (Google Account → Security → App passwords) and use that, not your normal password.
   - **Microsoft 365:** SMTP AUTH must be enabled for the mailbox by your admin.
3. Optionally limit recipient domains, set a daily cap, and blind-copy yourself on every agent email.
4. Tick **Send approved emails**, save, then **Send me a test email**.

An email is only ever sent after you approve that exact message in Approvals. Each one is recorded in the Outbox with its delivery status and the mail server's message ID.

### Docker

```bash
cp .env.example .env   # fill in JWT_SECRET, MASTER_KEY
POSTGRES_PASSWORD=$(openssl rand -hex 16) docker compose up --build
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Core unit tests + API integration tests (in-process Postgres) |
| `pnpm typecheck` | Type-check all packages |
| `pnpm db:migrate` | Apply database migrations |
| `pnpm seed` | Seed the 12 default agents; creates the CEO from `CEO_EMAIL`/`CEO_PASSWORD` if set |
| `scripts/backup.sh` | `pg_dump` backup with 14-day rotation |

## Layout

```
packages/core   Engine: orchestrator, policy engine, approvals, tools, memory, model router, agents
apps/api        Fastify API: Postgres store, auth/RBAC, encrypted secrets, settings, SSE, serves the dashboard
apps/web        React dashboard: Overview, Approvals, Tasks, Workforce, Knowledge, Audit log, Settings
docs/           ARCHITECTURE.md, SECURITY.md
```

## What works today

Verified by the test suite (42 tests) and by running the full stack against PostgreSQL 16.

- **Orchestration.** The Chief of Staff turns an objective into a dependency graph of department subtasks; plans are validated (known agents, no cycles, size limits). Independent work runs in parallel, dependent work waits for inputs, results are synthesized into a report to the CEO. Retries, escalation, cancellation, and recovery after restart.
- **Execution limits on every task tree:** delegation depth, subtask count, model calls, tool calls, steps per task, tokens, spend, wall-clock time, identical-call loop guard, repeated-failure guard. Recursive delegation and dependency deadlocks are refused.
- **Autonomy levels 0–3 enforced in the backend.** Agents only get tools explicitly assigned to them and only up to their level and the task's cap. Every Level 3 or sensitive action (external communication, publishing, deploys, spending, deletions, permission changes …) creates an approval for that exact input; it executes once, only after the CEO approves. Silence expires after 72h as a rejection. Delegation cannot bypass approval.
- **12 agents**, editable in the dashboard (prompts, responsibilities, model, tools, autonomy, memory scopes). Only the CEO can change permissions.
- **Model layer:** Anthropic and OpenAI via official SDKs, any OpenAI-compatible server (Ollama, LM Studio, vLLM), offline mock. Per-agent model profiles, fallback chains, retry with backoff, per-provider rate limits, context trimming, token and cost tracking, monthly budget.
- **Company memory:** seven scopes, versioning, provenance on every entry, CEO-verified vs. agent claims, conflict detection (agents cannot overwrite verified facts), archive/delete, per-agent access control, full-text search. Agents retrieve relevant memory before each task.
- **Security:** argon2id passwords, httpOnly session cookies, RBAC (CEO / admin / viewer), AES-256-GCM secret storage, credential redaction in logs, append-only audit log enforced by a database trigger, rate limiting, input validation on every endpoint, SSRF protection on web fetches, untrusted-content fencing with prompt-injection detection.
- **Email delivery (SMTP).** Approved emails are sent from your account, with a recipient domain allowlist, a daily cap, optional BCC to the CEO, a test-email button, delivery status and message IDs in the Outbox, and CEO-only resend of failed or queued messages. Tested against a real SMTP server.
- **Dashboard** covering all six areas of the spec plus the Outbox, with live updates.

## Not built yet

These are honest gaps, not hidden ones:

- **Publishing and deploy connectors.** Approved posts and deploys are recorded in the Outbox as "not sent"; no CMS or CI/CD connector exists yet. Email is connected (above). Inbound email (reading replies) is not built.
- **Code sandbox** is off by default. `SANDBOX=docker` runs code in locked-down containers (no network, read-only, capped CPU/memory); it is implemented but was not exercised in CI because the build environment had no Docker daemon.
- **Integrations** (GitHub, calendar, project management, cloud, monitoring, security scanning) and a real **web search** tool. `web.fetch` reads public pages only.
- **Semantic (vector) search** for memory; search is Postgres full-text today.
- **Scheduled research**, conversation memory for a CEO chat thread, user management UI beyond the API, MFA, and automated backup scheduling.
- The dashboard has no automated UI tests yet.

See `docs/ARCHITECTURE.md` for the suggested order of milestone 2.
