# Security model

The CEO holds final authority. The rules below are enforced in code and in the database, not by prompts. Prompts describe the rules to agents so they behave sensibly, but an agent that ignores its prompt still cannot do more than the backend allows.

## Accounts and roles

| Role | Can |
| --- | --- |
| CEO | everything, and is the only role that can decide approvals, change agent permissions, store secrets, change settings and policies, administer users |
| Admin | create and run tasks, edit agent prompts and responsibilities, write memory |
| Viewer | read everything |

- Passwords: argon2id. Sessions: signed JWT in an httpOnly, SameSite=Strict cookie (Secure in production), 12h lifetime. The role is re-read from the database on every request, so disabling a user takes effect immediately.
- First-run setup creates the CEO only while no users exist (single atomic insert).
- Login is rate-limited (10/min), the API overall 300/min per client.

## Agent permissions

- Agents start with no tools. Tools are assigned explicitly; unknown tool ids are rejected.
- Each tool declares input/output schemas (validated on every call), a minimum autonomy level, a risk class, sensitive action kinds, a timeout and a per-task call limit.
- Effective level = min(agent's max autonomy, the task's autonomy cap). Ad-hoc delegation additionally caps the child at the delegator's level.

## Approvals

- Required for any Level 3 tool and any sensitive action: external communication, publishing, spending, production deploys or data changes, deleting important data, security policy or access changes, signing agreements, irreversible decisions.
- Bound to `sha256(tool id + canonical JSON input)`. A different recipient, body, amount, etc. needs a new approval.
- Single use: execution consumes the approval with a compare-and-set in the database, so concurrent replays fail.
- Pending approvals expire after 72 hours and are never treated as approval.
- The CEO can edit an email's recipient, subject or body (or a post's title and content) before approving. The edited version is validated and checked exactly like an agent's draft (schema, do-not-contact list, outreach footer), the approval is re-bound to the edited version's hash so only that version can run, and the audit log keeps the agent's original next to the approved version. Other action types can't be edited, only approved, rejected or sent back with a note.

## Email

- Sending is reachable only through the `email.send` tool (Level 3, always needs an approval of the exact message) or by the CEO directly (test email to the CEO's own address; resending an already-approved message from the Outbox).
- The SMTP password is stored as the encrypted secret `SMTP_PASSWORD` and read only at send time. TLS 1.2+ is required; unencrypted SMTP is refused unless the server is on the same machine (for local testing).
- Recipient domain allowlist and a rolling 24-hour cap are checked before connecting to the mail server.
- Messages are plain text. Recipients are validated as email addresses, and headers are built by nodemailer, so message content can't inject headers.
- Resends use an atomic status change, so one approval can't produce two sends. Every configuration change, test and resend is audited.
- The agent receives the real outcome (`sent`, `failed`, or `queued_no_connector`) and is instructed never to claim an email was sent otherwise.

## Prompt injection

Tool output, web pages, other agents' results and stored memory are wrapped in `<untrusted_data>` / `<company_memory>` blocks marked as data. Text matching known injection patterns is flagged in the block and recorded in the audit log. This reduces the risk; the actual protection is that injected instructions can only lead to tool calls the policy engine already permits, and anything consequential still needs the CEO.

## Secrets

- API keys entered in Settings are encrypted with AES-256-GCM using `MASTER_KEY` from the environment. The key is never stored in the database.
- The API returns only names and the last four characters. Keys are read server-side by the model router; they are never placed in prompts, tool inputs or logs.
- Audit details are passed through a redactor that strips credential-looking fields and values.

## Data protection

- Audit log: append-only, enforced by a database trigger rejecting UPDATE and DELETE.
- Memory: never overwritten; every change is a new version. Deletion is a status change visible in the audit log.
- `web.fetch` blocks private, loopback, link-local and metadata addresses and does not follow redirects automatically.
- Code execution, when enabled, runs in Docker with no network, read-only root, non-root user, dropped capabilities, and CPU/memory/process/time limits.

## Operating it safely

- Run behind HTTPS (a reverse proxy) and set `NODE_ENV=production` so cookies are Secure.
- Back up the database with `scripts/backup.sh`, and back up `MASTER_KEY` separately.
- Keep `HOST=127.0.0.1` unless the API is behind a proxy.

Known limits: no MFA yet; single-tenant (one company per deployment); the approval UI relies on the CEO reading the exact payload shown.
