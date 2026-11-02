import { fileURLToPath } from "node:url";
import { DockerSandbox, DisabledSandbox } from "@aicos/core";
import { buildApp } from "./app.js";
import { connect } from "./db.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const db = await connect(process.env.DATABASE_URL ?? "pglite:./data/pglite");
const { app, company } = await buildApp({
  db,
  jwtSecret: required("JWT_SECRET"),
  masterKey: process.env.MASTER_KEY,
  webOrigin: process.env.WEB_ORIGIN,
  sandbox: process.env.SANDBOX === "docker" ? new DockerSandbox() : new DisabledSandbox(),
  staticDir: process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  secureCookies: process.env.NODE_ENV === "production",
  logger: true,
});

const resumed = await company.orchestrator.recover();
if (resumed) app.log.info(`resumed ${resumed} task tree(s) after restart`);
setInterval(() => company.approvals.expireStale().catch(() => {}), 60_000).unref();

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
