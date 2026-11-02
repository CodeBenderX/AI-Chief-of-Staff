import { DEFAULT_DATABASE_URL, env } from "./env.js";
import { fileURLToPath } from "node:url";
import { DockerSandbox, DisabledSandbox } from "@aicos/core";
import { buildApp } from "./app.js";
import { connect } from "./db.js";

function required(name: string): string {
  const v = env(name);
  if (!v) {
    console.error(`Missing ${name}. Run "pnpm run bootstrap" to create .env, or set it yourself (see .env.example).`);
    process.exit(1);
  }
  return v;
}

const db = await connect(env("DATABASE_URL") ?? DEFAULT_DATABASE_URL);
const { app, company } = await buildApp({
  db,
  jwtSecret: required("JWT_SECRET"),
  masterKey: env("MASTER_KEY"),
  webOrigin: env("WEB_ORIGIN"),
  sandbox: process.env.SANDBOX === "docker" ? new DockerSandbox() : new DisabledSandbox(),
  staticDir: env("STATIC_DIR") ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  secureCookies: process.env.NODE_ENV === "production",
  logger: true,
});

const resumed = await company.orchestrator.recover();
if (resumed) app.log.info(`resumed ${resumed} task tree(s) after restart`);
setInterval(() => company.approvals.expireStale().catch(() => {}), 60_000).unref();

const port = Number(env("PORT") ?? 8787);
const host = env("HOST") ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`\n  Company Console is running: http://${host === "0.0.0.0" ? "localhost" : host}:${port}\n  Press Ctrl+C to stop.\n`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
