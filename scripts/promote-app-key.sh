#!/usr/bin/env bash
# Move the GitHub App credentials from their D1 staging row into Worker
# secrets, then delete the row.
#
# The manifest flow has to park the key somewhere the Worker can write at
# runtime, and a Worker cannot write its own secrets — but D1 is a database,
# not a secret store, and Cloudflare's guidance is that sensitive values belong
# in secrets or a Secrets Store binding. So D1 holds the key only between
# `/app/setup` finishing and this script running.
#
# The key is never printed, never written to a file, and never passed as an
# argument (which would put it in the process list and in shell history).
set -euo pipefail

DB="${DB:-self-heal-db}"

read_field() {
  npx wrangler d1 execute "$DB" --remote --json \
    --command "SELECT $1 FROM github_app WHERE id = 1" 2>/dev/null \
    | python3 -c "import sys,json;r=json.load(sys.stdin)[0]['results'];print(r[0]['$1'],end='') if r else sys.exit(1)"
}

# Read and validate *before* writing anything. Piping read_field straight into
# `wrangler secret put` would set an empty secret whenever the read failed —
# pipefail reports the failure only after the write has already happened.
app_id="$(read_field app_id || true)"
private_key="$(read_field private_key || true)"

if [ -z "$app_id" ] || [ -z "$private_key" ]; then
  echo "✘ no staged github app row in D1 — run /app/setup on the deployed Worker first." >&2
  echo "  (If setup already completed, the key has been promoted and the row cleared.)" >&2
  exit 1
fi

case "$private_key" in
  *"PRIVATE KEY"*) ;;
  *) echo "✘ staged value does not look like a PEM private key; aborting." >&2; exit 1 ;;
esac

echo "→ promoting app_id"
printf '%s' "$app_id" | npx wrangler secret put GITHUB_APP_ID

echo "→ promoting private_key"
printf '%s' "$private_key" | npx wrangler secret put GITHUB_APP_KEY

echo "→ clearing the D1 staging row"
npx wrangler d1 execute "$DB" --remote --command "DELETE FROM github_app WHERE id = 1" >/dev/null

echo "✓ credentials now live in Worker secrets; D1 staging row removed."
echo "  Run 'pnpm deploy' if you have not already."
