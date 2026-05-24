-- Cohort Phase 0: Foundation
-- EU Supabase project required at deploy time

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ======================== ENUMS ========================
CREATE TYPE public.intent_type AS ENUM ('serious', 'open', 'casual');
CREATE TYPE public.spark_style AS ENUM ('curious', 'playful', 'value');
CREATE TYPE public.spark_status AS ENUM ('pending', 'accepted', 'declined', 'cancelled', 'expired');
CREATE TYPE public.spark_intent_level AS ENUM ('explore', 'open_to_meet', 'meet_soon');
CREATE TYPE public.thread_status AS ENUM (
  'active', 'ready_for_contract', 'revealed', 'date_alignment', 'match_closed', 'closed'
);
CREATE TYPE public.thread_close_reason AS ENUM (
  'declined', 'timeout', 'mutual_reveal', 'reported', 'post_reveal_timeout', 'explicit_end'
);
CREATE TYPE public.contract_decision AS ENUM ('yes', 'no');
CREATE TYPE public.contract_pace AS ENUM ('today', 'this_week', 'slow');
CREATE TYPE public.behavior_tier AS ENUM ('none', 'considerate', 'reliable');
CREATE TYPE public.report_status AS ENUM ('open', 'reviewing', 'resolved');
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
CREATE TYPE public.region_status AS ENUM ('waitlist', 'open', 'paused');
CREATE TYPE public.round_status AS ENUM ('forming', 'active', 'closed');
CREATE TYPE public.lane_type AS ENUM ('straight', 'lesbian', 'gay_male');
CREATE TYPE public.outbound_status AS ENUM ('pending', 'sending', 'delivered', 'failed', 'dead');
CREATE TYPE public.channel_type AS ENUM ('telegram', 'whatsapp', 'sms', 'web');
CREATE TYPE public.onboarding_status AS ENUM ('interviewing', 'complete', 'rejected');
CREATE TYPE public.match_confidence AS ENUM ('high', 'medium');

-- ======================== CONFIG ========================
CREATE TABLE public.cohort_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.cohort_config (key, value) VALUES
  ('ai.model.onboarding', '"claude-sonnet-4-6"'),
  ('ai.model.facilitation', '"claude-sonnet-4-6"'),
  ('ai.model.matching', '"claude-opus-4-7"'),
  ('sparks_per_week_free', '5'),
  ('between_rounds_mode', '"quiet"'),
  ('spark_message_min_chars', '20'),
  ('spark_message_max_chars', '280'),
  ('spark_expiry_hours', '48'),
  ('thread_turn_hours', '72'),
  ('min_age_years', '18');

-- ======================== REGIONS ========================
CREATE TABLE public.regions (
  region_key TEXT PRIMARY KEY,
  status public.region_status NOT NULL DEFAULT 'waitlist',
  opened_at TIMESTAMPTZ,
  min_suggestions_per_round INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.regions (region_key, status, opened_at) VALUES
  ('berlin', 'open', now());

CREATE TABLE public.region_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_key TEXT NOT NULL REFERENCES public.regions(region_key),
  user_id UUID,
  email TEXT,
  phone TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.region_demand_stats (
  region_key TEXT PRIMARY KEY REFERENCES public.regions(region_key),
  waitlist_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ======================== USERS (canonical, not channel-specific) ========================
CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'active',
  date_of_birth DATE,
  age_verified_at TIMESTAMPTZ,
  age_verification_method TEXT,
  primary_phone TEXT UNIQUE,
  primary_email TEXT UNIQUE,
  gdpr_consent_at TIMESTAMPTZ,
  marketing_consent_at TIMESTAMPTZ,
  whatsapp_contact_consent_at TIMESTAMPTZ,
  preferred_outbound_channel public.channel_type DEFAULT 'telegram',
  locale TEXT NOT NULL DEFAULT 'de',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.channel_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel public.channel_type NOT NULL,
  external_id TEXT NOT NULL,
  external_username TEXT,
  verified_at TIMESTAMPTZ,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

CREATE INDEX idx_channel_identities_user ON public.channel_identities(user_id);
CREATE INDEX idx_channel_identities_lookup ON public.channel_identities(channel, external_id);

CREATE TABLE public.phone_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.channel_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_channel public.channel_type NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ======================== EVENTS & OUTBOX ========================
CREATE TABLE public.domain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_domain_events_type ON public.domain_events(event_type, created_at DESC);

CREATE TABLE public.outbound_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel public.channel_type NOT NULL,
  template_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE,
  status public.outbound_status NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX idx_outbound_pending ON public.outbound_deliveries(status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- ======================== CONSENT ========================
CREATE TABLE public.consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,
  version TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash TEXT
);
