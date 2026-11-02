# Architecture

## Components

```
            ┌──────────── apps/web (React dashboard) ────────────┐
            │ Overview · Approvals · Tasks · Workforce · ...     │
            └───────────────┬─────────── SSE live events ────────┘
                            │ REST /api (cookie session, RBAC)
┌───────────────────────────▼──────────────────────────────────────────┐
│ apps/api (Fastify)                                                  │
│  auth/RBAC · settings · SecretStore (AES-GCM) · DbOutbox · DbDocuments│
│  PgStore ──────────────── implements core Store port ───────────────┐│
└───────────────────────────┬─────────────────────────────────────────┘│
                            │                                         ▼
┌───────────────────────────▼──────────────── packages/core ──────────────┐
│ Orchestrator ─► PolicyEngine ─► ToolExecutor ─► ToolRegistry (tools)      │
│      │               │               └► ApprovalService (action hashes)   │
│      ├► ModelRouter (profiles, fallback, retry, rate limit, cost)         │
│      │     └► providers: Anthropic · OpenAI · OpenAI-compatible · Mock    │
│      ├► MemoryService (scopes, versions, provenance, conflicts)           │
│      └► AuditLog                                                          │
└───────────────────────────────────────────────────────────────────────────┘
                            PostgreSQL 16 (or PGlite in dev/tests)
```

`packages/core` has no web or database dependencies. Everything it persists goes through the `Store` interface, so the engine is tested in memory and runs on Postgres in production.

## Task lifecycle

1. **Submit.** The CEO's objective becomes a root task owned by the Chief of Staff (or a named department). The task gets execution limits from Settings and an autonomy cap.
2. **Plan.** The Chief of Staff retrieves relevant memory and returns a JSON plan. `validatePlan` checks agents, keys, dependencies and cycles. Two invalid plans → the Chief of Staff handles the objective directly.
3. **Schedule.** Ready subtasks (all dependencies completed) run in priority order up to `concurrency`. A subtask whose dependency failed is failed; anything left un-runnable is failed as a deadlock rather than hanging.
4. **Agent loop.** Each agent gets its assignment, dependency outputs (fenced as untrusted), and authorized memory. It may call its tools for up to `maxStepsPerTask` steps. Every call passes the PolicyEngine:
   - not assigned / above level → refused, the agent is told why;
   - Level 3 or sensitive → an approval is created for that exact input and the task pauses (`awaiting_approval`), with the transcript saved.
5. **Approval.** The CEO approves, rejects or requests changes. Approve → the saved call executes once (the approval is consumed atomically). Otherwise the agent is told the decision and adapts.
6. **Synthesize.** When all subtasks finish, the Chief of Staff writes the report. Any failure marks the root `escalated` so it surfaces to the CEO. The outcome is stored in task memory as an unverified claim.

Every step appends to `task_events`, the complete execution history shown on each task page.

## Safeguards and where they live

| Risk | Guard |
| --- | --- |
| Infinite loops | identical tool call limit, per-tool call limit, step limit |
| Excessive API calls / tokens / cost | per-tree budget checked before every model call; rebuilt from the DB after restarts |
| Unbounded execution | wall-clock limit per tree; cancellation aborts in-flight work |
| Repeated failures | retries capped; identical failing work (same agent + instructions) stops retrying |
| Recursive delegation | an agent already in the delegation chain can't be delegated to; depth limit |
| Deadlock | cycle detection at plan time; unrunnable tasks failed at run time |
| Approval bypass | approval is keyed to tool + exact input hash, not to an agent; delegated work can't raise autonomy |

## Suggested milestone 2

1. ~~Email delivery~~ (done: SMTP connector behind the outbox). Next connectors: GitHub pull requests, a CMS for publishing, and reading inbound replies.
2. GitHub integration and the Docker sandbox in CI for the engineering department.
3. A real web search tool with source capture for market research, and scheduled research.
4. pgvector embeddings for memory search.
5. A CEO conversation thread (short-term memory) on top of task submission.
6. Playwright UI tests; MFA for the CEO account.
