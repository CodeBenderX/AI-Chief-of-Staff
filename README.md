# AI Company Operating System

A platform for running a company with an AI workforce and a human CEO. You brief the company in one place; the AI Chief of Staff plans the work, delegates it to department agents, runs it under hard limits, pauses for your approval before anything external or irreversible happens, and reports back.

Status: **milestone 1, working core slice.** See [What works today](#what-works-today) and [Not built yet](#not-built-yet) for an exact account.

## Run it on your computer

Works on Windows, macOS and Linux. No database to install: data is kept in the `data` folder.

**You need:** [Node.js 22 LTS](https://nodejs.org) or newer, and [Git](https://git-scm.com). Check with `node -v` (must print v20.12 or higher).

```bash
# 1. Install pnpm (once per computer)
npm install -g pnpm

# 2. Get the code
git clone https://github.com/CodeBenderX/AI-Chief-of-Staff.git
cd AI-Chief-of-Staff

# 3. Install and set up (creates .env with secret keys, then builds everything)
pnpm install
pnpm run bootstrap

# 4. Start it
pnpm start
```

Open **http://localhost:8787** and create your CEO account. Stop the app with `Ctrl+C`; run `pnpm start` again to restart. Your data is kept.

After pulling new code (`git pull`), run `pnpm install` and `pnpm run build` before `pnpm start`.

**If something goes wrong**
- `pnpm` is not recognized: close and reopen the terminal after step 1. On Windows, if PowerShell says scripts are disabled, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt.
- Port 8787 is in use: change `PORT` in `.env`.
- Forgot the CEO password during local testing: stop the app, delete the `data` folder (this erases everything) and start again.

### Connect a local model (LM Studio or Ollama)

Without a model, the app runs on a built-in offline mock so you can try the screens; its answers are placeholders.

**LM Studio**
1. In LM Studio, download a model that supports tool use (for example Qwen 2.5 7B Instruct or Llama 3.1 8B Instruct) and load it.
2. Open the **Developer** tab and turn on **Start server** (it runs at `http://localhost:1234`). Copy the model's identifier shown there.
3. In the app, go to **Settings → AI models**:
   - In Providers, tick **On** for `lmstudio`.
   - In Model profiles, for **Local (Ollama)** and **Planner (local)**: set Provider to `lmstudio` and Model to the identifier you copied.
   - Click **Save model settings**. The `lmstudio` row should show "ready".

**Ollama**: run `ollama pull llama3.1:8b`; the default profiles already point at Ollama, so nothing else is needed (change the model name in Settings if you pulled a different one).

Small local models follow the planning format less reliably than large hosted ones; the app rejects bad plans and retries, then has the Chief of Staff handle the request directly. To use Claude or OpenAI instead, add the key in **Settings → API keys** and pick the `claude` or `gpt` profile for your agents.

### For developers

- `pnpm dev:api` restarts the API on code changes; `pnpm dev:web` serves the dashboard with hot reload at http://localhost:5173.
- To use PostgreSQL instead of the built-in database, set `DATABASE_URL` in `.env`.
- Docker: `docker compose up --build` with `POSTGRES_PASSWORD` set (see below).

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
pnpm install && node scripts/bootstrap.mjs   # creates .env (or copy .env.example and fill it in)
POSTGRES_PASSWORD=choose-a-password docker compose up --build
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm run bootstrap` | First-time setup: create `.env` with secret keys, build everything |
| `pnpm start` | Run the app at http://localhost:8787 |
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
