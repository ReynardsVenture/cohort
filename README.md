# Cohort

Channel-native slow-dating platform — [meetcohort.co](https://meetcohort.co)

Telegram-first build; WhatsApp adapter last. Supabase **EU** required.

## Stack

- **Postgres + pgvector** (Supabase EU)
- **Edge Functions** (Deno/TypeScript)
- **Anthropic Claude** via `ai-proxy` only
- Channels: Telegram → SMS → Web → WhatsApp

## Quick start

### Prerequisites

- **Supabase CLI** (installed globally: `npm install -g supabase`, or use `npm run supabase` in this repo)
- **Cloud:** Supabase account + project in **EU** region
- **Local (optional):** Docker Desktop for `supabase start`

### One-command setup (cloud)

```bash
cd cohort
npm install
supabase login                    # opens browser — complete once
bash scripts/setup-backend.sh   # link project, db push, optional deploy
```

Or step by step:

```bash
cd cohort
cp .env.example .env
supabase login
# Create project at https://supabase.com/dashboard (region: Europe)
supabase link --project-ref YOUR_PROJECT_REF
npm run db:push
npm run functions:deploy
```

Copy API keys into `.env`:

```bash
supabase projects api-keys --project-ref "$(cat supabase/.temp/project-ref)"
```

### Local development (Docker)

```bash
npm run setup:local   # supabase start + db reset
npm run functions:serve
```

2. Set Telegram webhook:

   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<SUPABASE_URL>/functions/v1/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```

3. Schedule crons (Supabase dashboard or external):

   - `dispatcher-run` — every 30s
   - `cron-weekly-matching` — weekly (before rounds)
   - `cron-activate-rounds` — after matching
   - `cron-expire-sparks` — hourly

4. **Start WABA verification** (Meta) in parallel — independent of code.

## Project layout

| Path | Purpose |
|------|---------|
| `supabase/migrations/` | Schema, RLS, helpers |
| `supabase/functions/` | Edge functions |
| `supabase/functions/_shared/` | Core, outbox, identity, templates |
| `prompts/` | Version-controlled AI prompts |
| `web/` | React/Vite app (Phase 11) |

## Config (`cohort_config`)

| Key | Default |
|-----|---------|
| `ai.model.onboarding` | `claude-sonnet-4-6` |
| `ai.model.facilitation` | `claude-sonnet-4-6` |
| `ai.model.matching` | `claude-opus-4-7` |
| `sparks_per_week_free` | `5` |
| `between_rounds_mode` | `quiet` |

## Core journey

1. Onboarding (AI interview, no photos)
2. Weekly round with **reasoned** match suggestions
3. Spark (budget-limited) → accept → AI-facilitated thread
4. Contract (mutual yes + pace) → reveal
5. Mediated relay chat

## Security

Channel adapters resolve `(channel, external_id) → user_id` in-process; business HTTP functions are **internal-only** (not client JWT yet).

### Edge function auth (application-layer)

| Category | Functions | Credential |
|----------|-----------|------------|
| **internal-secret** | `send-spark`, `respond-spark`, `submit-thread-turn`, `submit-contract-decision`, `send-relay-message`, `identity-*`, `ai-proxy`, `register-fingerprint`, `request-data-export`, `request-account-deletion`, `create-checkout` | `Authorization: Bearer $COHORT_INTERNAL_SECRET` |
| **provider-verified** | `telegram-webhook`, `whatsapp-webhook`, `sms-webhook`, `payments-webhook` | Telegram secret / Meta `X-Hub-Signature-256` / Twilio signature / Stripe signature |
| **cron-secret** | `dispatcher-run`, `cron-*` | `Authorization: Bearer $COHORT_CRON_SECRET` |

Set secrets before deploy:

```bash
supabase secrets set \
  COHORT_INTERNAL_SECRET="$(openssl rand -hex 32)" \
  COHORT_CRON_SECRET="$(openssl rand -hex 32)"
```

Local `supabase functions serve` only: `COHORT_ALLOW_OPEN_INTERNAL=true` (never in production).

Future web app (Phase 11): separate client-facing endpoints with `verify_jwt = true` and `user_id` from the token only.

- No peer channel IDs in relay payloads
- `age_verification_method = self_declared` at launch (pluggable)

### Tests

```bash
npm test          # Deno unit tests (auth, dispatcher, outbox)
npm run test:db   # SQL transactional tests (requires Docker + supabase start)
```

## License

Proprietary — Cohort
