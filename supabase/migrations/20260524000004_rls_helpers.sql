-- Cohort: RLS policies and SECURITY DEFINER helpers

ALTER TABLE public.cohort_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sparks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.round_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relay_messages ENABLE ROW LEVEL SECURITY;

-- ======================== HELPERS ========================
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id, 'admin');
$$;

CREATE OR REPLACE FUNCTION public.is_blocked(_a UUID, _b UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE (blocker_id = _a AND blocked_id = _b)
       OR (blocker_id = _b AND blocked_id = _a)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_round_member(_round_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.round_members
    WHERE round_id = _round_id AND user_id = _user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_same_active_round(_a UUID, _b UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.round_members rm_a
    JOIN public.round_members rm_b ON rm_b.round_id = rm_a.round_id
    JOIN public.weekly_rounds wr ON wr.id = rm_a.round_id
    WHERE rm_a.user_id = _a AND rm_b.user_id = _b
      AND wr.status = 'active'
      AND wr.week_start <= CURRENT_DATE AND wr.week_end >= CURRENT_DATE
  );
$$;

CREATE OR REPLACE FUNCTION public.is_thread_participant(_thread_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.threads
    WHERE id = _thread_id AND (_user_id = user_a OR _user_id = user_b)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_thread_revealed(_thread_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.threads
    WHERE id = _thread_id
      AND status IN ('revealed', 'date_alignment', 'match_closed')
      AND revealed_at IS NOT NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.user_is_age_verified(_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT age_verified_at IS NOT NULL
  FROM public.users WHERE id = _user_id;
$$;

CREATE OR REPLACE FUNCTION public.get_config_text(_key TEXT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT value #>> '{}' FROM public.cohort_config WHERE key = _key;
$$;

CREATE OR REPLACE FUNCTION public.get_config_int(_key TEXT)
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (value)::text::int FROM public.cohort_config WHERE key = _key;
$$;

-- Contract mutual reveal (row-locked)
CREATE OR REPLACE FUNCTION public.submit_contract_decision(
  _thread_id UUID,
  _user_id UUID,
  _decision public.contract_decision,
  _pace public.contract_pace
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t RECORD;
  c RECORD;
  is_a BOOLEAN;
BEGIN
  SELECT * INTO t FROM public.threads WHERE id = _thread_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'thread_not_found'; END IF;
  IF t.status != 'ready_for_contract' THEN RAISE EXCEPTION 'invalid_thread_status'; END IF;

  SELECT * INTO c FROM public.contracts WHERE thread_id = _thread_id FOR UPDATE;
  is_a := (_user_id = t.user_a);

  IF is_a THEN
    UPDATE public.contracts SET decision_a = _decision, pace_a = _pace
    WHERE thread_id = _thread_id;
  ELSE
    UPDATE public.contracts SET decision_b = _decision, pace_b = _pace
    WHERE thread_id = _thread_id;
  END IF;

  SELECT * INTO c FROM public.contracts WHERE thread_id = _thread_id;

  IF c.decision_a IS NOT NULL AND c.decision_b IS NOT NULL THEN
    IF c.decision_a = 'yes' AND c.decision_b = 'yes' THEN
      UPDATE public.threads SET status = 'revealed', revealed_at = now(), updated_at = now()
      WHERE id = _thread_id;
      UPDATE public.contracts SET resolved_at = now() WHERE thread_id = _thread_id;
      UPDATE public.profiles SET reveal_count = reveal_count + 1
      WHERE user_id IN (t.user_a, t.user_b);
      RETURN jsonb_build_object('outcome', 'revealed');
    ELSE
      UPDATE public.threads SET status = 'closed', close_reason = 'declined', closed_at = now()
      WHERE id = _thread_id;
      UPDATE public.contracts SET resolved_at = now() WHERE thread_id = _thread_id;
      RETURN jsonb_build_object('outcome', 'declined');
    END IF;
  END IF;

  RETURN jsonb_build_object('outcome', 'pending');
END;
$$;

-- ======================== RLS: deny by default, minimal client access ========================
CREATE POLICY users_select_own ON public.users FOR SELECT USING (id = auth.uid());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = auth.uid());

CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY profiles_select_round_peers ON public.profiles FOR SELECT
  USING (public.is_same_active_round(auth.uid(), user_id) AND user_id != auth.uid());
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY channel_identities_select_own ON public.channel_identities FOR SELECT
  USING (user_id = auth.uid());

-- Server-only tables: no client policies (service role only)
-- domain_events, outbound_deliveries, match_suggestions, sparks insert, etc.

CREATE POLICY blocks_insert_own ON public.blocks FOR INSERT WITH CHECK (blocker_id = auth.uid());
CREATE POLICY blocks_select_own ON public.blocks FOR SELECT USING (blocker_id = auth.uid());

CREATE POLICY reports_insert_own ON public.reports FOR INSERT WITH CHECK (reporter_id = auth.uid());

CREATE POLICY messages_select_participant ON public.messages FOR SELECT
  USING (public.is_thread_participant(thread_id, auth.uid()));
CREATE POLICY messages_insert_revealed ON public.messages FOR INSERT
  WITH CHECK (
    sender_user_id = auth.uid()
    AND public.is_thread_revealed(thread_id)
    AND public.is_thread_participant(thread_id, auth.uid())
  );

-- Note: auth.uid() maps to users.id when using custom JWT or link auth.users to users table in web phase
