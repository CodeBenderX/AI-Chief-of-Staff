import { seedAgents } from "@aicos/core";
import { hashPassword } from "./auth.js";
import { connect, migrate } from "./db.js";
import { PgStore } from "./pgStore.js";
import { newId } from "@aicos/core";

const [cmd] = process.argv.slice(2);
const db = await connect(process.env.DATABASE_URL ?? "pglite:./data/pglite");

try {
  if (cmd === "migrate") {
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
  } else if (cmd === "seed") {
    await migrate(db);
    await seedAgents(new PgStore(db));
    const email = process.env.CEO_EMAIL;
    const password = process.env.CEO_PASSWORD;
    if (email && password) {
      if (password.length < 12) throw new Error("CEO_PASSWORD must be at least 12 characters");
      const r = await db.query(`INSERT INTO users (id, email, name, password_hash, role) SELECT $1,$2,$3,$4,'ceo' WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id`, [newId("usr"), email.toLowerCase(), "CEO", await hashPassword(password)]);
      console.log(r.length ? `CEO account created for ${email}` : "users already exist; CEO account not created");
    } else {
      console.log("agents seeded. Create the CEO account in the dashboard (first-run setup) or set CEO_EMAIL / CEO_PASSWORD.");
    }
  } else {
    console.log("usage: cli.ts migrate | seed");
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
