import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Repository root (apps/api/dist/env.js → ../../..). */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Load the repo's .env automatically, on every OS. Values already set in the
 * real environment win, so production can still use real environment variables.
 */
const envFile = `${ROOT}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Embedded database location used when DATABASE_URL is empty. */
export const DEFAULT_DATABASE_URL = `pglite:${ROOT}data/pglite`;

/** Treat empty strings from .env ("KEY=") as unset. */
export const env = (name: string): string | undefined => process.env[name] || undefined;
