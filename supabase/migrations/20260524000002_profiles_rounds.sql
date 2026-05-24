-- Cohort: Profiles, weekly rounds, sparks, threads

CREATE TABLE public.profiles (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  display_name TEXT,
  intent public.intent_type,
  gender TEXT,
  seeking TEXT[] DEFAULT '{}',
  region_key TEXT REFERENCES public.regions(region_key),
  bio_structured JSONB DEFAULT '{}',
  interview_transcript_ref TEXT,
  embedding vector(1536),
  onboarding_status public.onboarding_status NOT NULL DEFAULT 'interviewing',
  moderation_status TEXT NOT NULL DEFAULT 'active',
  moderation_until TIMESTAMPTZ,
  behavior_tier public.behavior_tier NOT NULL DEFAULT 'none',
  behavior_score INT NOT NULL DEFAULT 0,
  is_paused BOOLEAN NOT NULL DEFAULT false,
  reveal_count INT NOT NULL DEFAULT 0,
  timeout_count_30d INT NOT NULL DEFAULT 0,
  block_count INT NOT NULL DEFAULT 0,
  rounds_joined_count INT NOT NULL DEFAULT 0,
  last_lane_type public.lane_type,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.profile_private_media (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  photo_full_paths JSONB NOT NULL DEFAULT '[]',
  blur_path TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'pending_review',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.profile_text_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  prompt_key TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  UNIQUE (user_id, prompt_key)
);

CREATE TABLE public.ai_interview_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  prompt_version TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]',
  running_summary JSONB DEFAULT '{}',
  structured_output JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.weekly_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_key TEXT NOT NULL REFERENCES public.regions(region_key),
  intent_lane public.intent_type NOT NULL,
  lane_type public.lane_type NOT NULL,
  match_key TEXT NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  status public.round_status NOT NULL DEFAULT 'forming',
  min_size INT NOT NULL DEFAULT 4,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (region_key, match_key, week_start)
);

CREATE TABLE public.round_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES public.weekly_rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);

CREATE UNIQUE INDEX idx_round_members_one_per_week
  ON public.round_members (user_id, round_id);

CREATE TABLE public.weekly_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES public.weekly_rounds(id) ON DELETE CASCADE,
  sparks_sent INT NOT NULL DEFAULT 0,
  sparks_budget INT NOT NULL DEFAULT 5,
  threads_active INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, round_id)
);

CREATE TABLE public.match_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES public.weekly_rounds(id) ON DELETE CASCADE,
  for_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  suggested_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason_text TEXT NOT NULL CHECK (char_length(reason_text) >= 10),
  confidence public.match_confidence NOT NULL DEFAULT 'high',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, for_user_id, suggested_user_id),
  CHECK (for_user_id != suggested_user_id)
);

CREATE TABLE public.sparks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES public.weekly_rounds(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  style public.spark_style NOT NULL,
  message TEXT NOT NULL,
  intent_level public.spark_intent_level NOT NULL DEFAULT 'explore',
  status public.spark_status NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, from_user_id, to_user_id),
  CHECK (from_user_id != to_user_id)
);

CREATE TABLE public.threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spark_id UUID NOT NULL UNIQUE REFERENCES public.sparks(id) ON DELETE CASCADE,
  user_a UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status public.thread_status NOT NULL DEFAULT 'active',
  current_turn INT NOT NULL DEFAULT 1,
  turn_deadline TIMESTAMPTZ,
  facilitator_state JSONB DEFAULT '{}',
  revealed_at TIMESTAMPTZ,
  close_reason public.thread_close_reason,
  closed_at TIMESTAMPTZ,
  date_alignment_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_a != user_b)
);

CREATE TABLE public.thread_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  turn_number INT NOT NULL,
  facilitator_prompt TEXT NOT NULL,
  user_a_response TEXT,
  user_b_response TEXT,
  submitted_at_a TIMESTAMPTZ,
  submitted_at_b TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, turn_number)
);

CREATE TABLE public.contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL UNIQUE REFERENCES public.threads(id) ON DELETE CASCADE,
  user_a UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  decision_a public.contract_decision,
  decision_b public.contract_decision,
  pace_a public.contract_pace,
  pace_b public.contract_pace,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  relay_delivery_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.date_alignment_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  timeframe TEXT,
  format TEXT,
  skipped BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, user_id)
);

CREATE TABLE public.date_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  proposed_by UUID NOT NULL REFERENCES public.users(id),
  plan_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  agreed_by_a BOOLEAN NOT NULL DEFAULT false,
  agreed_by_b BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_region ON public.profiles(region_key);
CREATE INDEX idx_sparks_round ON public.sparks(round_id);
CREATE INDEX idx_threads_users ON public.threads(user_a, user_b);
CREATE INDEX idx_weekly_rounds_week ON public.weekly_rounds(week_start, region_key, status);
