#!/usr/bin/env bash
# Cohort backend setup — Supabase EU (cloud) or local (Docker)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.nvm/versions/node/v18.20.5/bin:$PATH"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Installing Supabase CLI via npm..."
  npm install -g supabase
fi

echo "Supabase CLI: $(supabase --version)"

# --- Auth ---
if ! supabase projects list >/dev/null 2>&1; then
  echo ""
  echo "Not logged in. Run this in your terminal (opens browser):"
  echo "  supabase login"
  echo ""
  echo "Or set SUPABASE_ACCESS_TOKEN from https://supabase.com/dashboard/account/tokens"
  echo "  export SUPABASE_ACCESS_TOKEN=sbp_..."
  exit 1
fi

MODE="${1:-}"

if [[ "$MODE" == "local" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for local Supabase. Install Docker Desktop or run: $0 cloud"
    exit 1
  fi
  echo "Starting local Supabase..."
  supabase start
  supabase db reset
  echo ""
  echo "Local URLs:"
  supabase status
  echo ""
  echo "Copy keys from above into .env (see .env.example)"
  exit 0
fi

# --- Cloud (default) ---
if [[ ! -f supabase/.temp/project-ref ]]; then
  echo ""
  echo "Link to your EU Supabase project (create at https://supabase.com/dashboard — region: Europe):"
  echo "  supabase link --project-ref YOUR_PROJECT_REF"
  echo ""
  read -r -p "Project ref (or press Enter to skip link): " PROJECT_REF
  if [[ -n "${PROJECT_REF:-}" ]]; then
    supabase link --project-ref "$PROJECT_REF"
  else
    echo "Skipping link. Run 'supabase link --project-ref ...' when ready."
    exit 0
  fi
fi

echo "Pushing migrations..."
supabase db push

echo ""
echo "Set Edge Function secrets (edit values, then re-run this block):"
cat <<'SECRETS'
  supabase secrets set \
    COHORT_CRON_SECRET="$(openssl rand -hex 32)" \
    COHORT_PHONE_OTP_SALT="$(openssl rand -hex 16)" \
    ANTHROPIC_API_KEY="your-key" \
    TELEGRAM_BOT_TOKEN="" \
    TELEGRAM_WEBHOOK_SECRET=""
SECRETS

read -r -p "Deploy all edge functions now? [y/N] " DEPLOY
if [[ "${DEPLOY,,}" == "y" ]]; then
  supabase functions deploy
  echo "Done. Configure Telegram webhook with your project URL."
fi

echo ""
echo "Write SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env from:"
echo "  supabase projects api-keys --project-ref \$(cat supabase/.temp/project-ref)"
