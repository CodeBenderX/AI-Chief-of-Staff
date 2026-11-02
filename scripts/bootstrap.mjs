// First-time local setup. Works on Windows, macOS and Linux.
// Creates .env with freshly generated secrets, or fills in missing ones in an existing .env.
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

const generators = {
  JWT_SECRET: () => randomBytes(32).toString("hex"),
  MASTER_KEY: () => randomBytes(32).toString("base64"),
};

const existed = existsSync(envPath);
let text = existed ? readFileSync(envPath, "utf8").replace(/^﻿/, "") : readFileSync(`${root}.env.example`, "utf8");
const filled = [];
for (const [name, make] of Object.entries(generators)) {
  const line = new RegExp(`^${name}=(.*)$`, "m");
  const m = line.exec(text);
  if (m && m[1].trim()) continue; // already has a value: keep it
  if (m) text = text.replace(line, `${name}=${make()}`);
  else text = `${text.replace(/\s*$/, "\n")}${name}=${make()}\n`;
  filled.push(name);
}
if (!existed || filled.length) writeFileSync(envPath, text);

if (!existed) console.log("✔ Created .env with new secret keys.");
else if (filled.length) console.log(`✔ Added missing ${filled.join(" and ")} to your existing .env.`);
else console.log("✔ .env already has its secret keys.");
if (!existed || filled.includes("MASTER_KEY")) {
  console.log("  Keep MASTER_KEY safe: it encrypts the API keys and email password you save in Settings.");
}
