#!/usr/bin/env bash
# Back up the database to ./backups/aicos-<timestamp>.dump (custom format, compressed).
# Restore: pg_restore --clean --if-exists -d "$DATABASE_URL" backups/<file>.dump
# MASTER_KEY is NOT in the dump. Store it separately or stored API keys cannot be decrypted.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
mkdir -p backups
out="backups/aicos-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner "$DATABASE_URL" -f "$out"
echo "wrote $out"
# Keep the 14 most recent backups.
ls -1t backups/aicos-*.dump | tail -n +15 | xargs -r rm --
