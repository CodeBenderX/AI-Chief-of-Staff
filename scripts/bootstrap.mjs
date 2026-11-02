// First-time local setup. Works on Windows, macOS and Linux.
// Creates .env with freshly generated secrets (if it doesn't exist yet).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = `${root}.env`;

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Node.js ${process.versions.node} is too old. Install Node.js 22 LTS or newer from https://nodejs.org and try again.`);
  process.exit(1);
}

if (existsSync(envPath)) {
  console.log("✔ .env already exists, keeping it (delete it and re-run to start fresh).");
} else {
  const template = readFileSync(`${root}.env.example`, "utf8");
  const filled = template
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomBytes(32).toString("hex")}`)
    .replace(/^MASTER_KEY=.*$/m, `MASTER_KEY=${randomBytes(32).toString("base64")}`);
  writeFileSync(envPath, filled);
  console.log("✔ Created .env with new secret keys.");
  console.log("  Keep MASTER_KEY safe: it encrypts the API keys and email password you save in Settings.");
}
