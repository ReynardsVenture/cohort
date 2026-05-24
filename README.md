# Cohort

Channel-native slow-dating platform — [meetcohort.co](https://meetcohort.co)

Telegram-first build; WhatsApp adapter last. Supabase **EU** required.

## Stack

- **Postgres + pgvector** (Supabase EU)
- **Edge Functions** (Deno/TypeScript)
- **Anthropic Claude** via `ai-proxy` only
- Channels: Telegram → SMS → Web → WhatsApp

## Quick start

1. Create a Supabase project in **EU** and link:

   ```bash
   cd cohort
   cp .env.example .env
   # fill SUPABASE_* and channel keys
   supabase link --project-ref <ref>
   supabase db push
   supabase functions deploy
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

- Identity, dispatcher, relay, payments: service-role + tests
- No peer channel IDs in relay payloads
- `age_verification_method = self_declared` at launch (pluggable)

## License

Proprietary — Cohort
