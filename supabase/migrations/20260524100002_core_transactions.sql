-- Fix #2–#4: Atomic core RPCs, relay client_message_id, idempotent outbox helper

ALTER TABLE public.relay_messages
  ADD COLUMN IF NOT EXISTS client_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_messages_client_dedupe
  ON public.relay_messages (relay_thread_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

-- Idempotent outbox insert (used only inside transactions)
CREATE OR REPLACE FUNCTION public.enqueue_outbound(
  _user_id UUID,
  _channel public.channel_type,
  _template_key TEXT,
  _payload JSONB,
  _idempotency_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.outbound_deliveries (
    user_id, channel, template_key, payload, idempotency_key, status, next_attempt_at
  ) VALUES (
    _user_id, _channel, _template_key, _payload, _idempotency_key, 'pending', now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.outbound_deliveries WHERE idempotency_key = _idempotency_key;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_outbound_channel(_user_id UUID)
RETURNS public.channel_type
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(preferred_outbound_channel, 'telegram'::public.channel_type)
  FROM public.users WHERE id = _user_id;
$$;

CREATE OR REPLACE FUNCTION public.ensure_weekly_quota(_user_id UUID, _round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_budget INT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.weekly_quotas WHERE user_id = _user_id AND round_id = _round_id) THEN
    RETURN;
  END IF;

  SELECT COALESCE(e.sparks_per_week, public.get_config_int('sparks_per_week_free'), 5) INTO v_budget
  FROM public.users u
  LEFT JOIN public.subscriptions s ON s.user_id = u.id
  LEFT JOIN public.entitlements e ON e.tier = COALESCE(s.tier, 'free')
  WHERE u.id = _user_id;

  INSERT INTO public.weekly_quotas (user_id, round_id, sparks_sent, sparks_budget)
  VALUES (_user_id, _round_id, 0, v_budget);
END;
$$;

-- Fix #2 + #3: send spark atomically with guarded quota increment
CREATE OR REPLACE FUNCTION public.send_spark_tx(
  _from_user_id UUID,
  _to_user_id UUID,
  _round_id UUID,
  _style public.spark_style,
  _message TEXT,
  _intent_level public.spark_intent_level,
  _expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_spark_id UUID;
  v_event_id UUID;
  v_channel public.channel_type;
  v_rows INT;
BEGIN
  IF _from_user_id = _to_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'self_spark');
  END IF;

  IF public.is_blocked(_from_user_id, _to_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'blocked');
  END IF;

  PERFORM public.ensure_weekly_quota(_from_user_id, _round_id);

  UPDATE public.weekly_quotas
  SET sparks_sent = sparks_sent + 1
  WHERE user_id = _from_user_id
    AND round_id = _round_id
    AND sparks_sent < sparks_budget;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'spark_budget_exceeded');
  END IF;

  INSERT INTO public.sparks (
    round_id, from_user_id, to_user_id, style, message, intent_level, expires_at
  ) VALUES (
    _round_id, _from_user_id, _to_user_id, _style, _message, _intent_level, _expires_at
  )
  RETURNING id INTO v_spark_id;

  INSERT INTO public.domain_events (aggregate_type, aggregate_id, event_type, payload)
  VALUES ('spark', v_spark_id, 'spark.sent', jsonb_build_object('spark_id', v_spark_id))
  RETURNING id INTO v_event_id;

  v_channel := public.user_outbound_channel(_to_user_id);
  PERFORM public.enqueue_outbound(
    _to_user_id,
    v_channel,
    'spark_received',
    jsonb_build_object('preview', left(_message, 80), 'spark_id', v_spark_id),
    v_event_id::text || ':' || _to_user_id::text || ':spark_received'
  );

  RETURN jsonb_build_object('success', true, 'spark_id', v_spark_id, 'event_id', v_event_id);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_spark');
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_spark_decline_tx(
  _user_id UUID,
  _spark_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s RECORD;
  v_channel public.channel_type;
BEGIN
  SELECT * INTO s FROM public.sparks WHERE id = _spark_id FOR UPDATE;
  IF NOT FOUND OR s.to_user_id != _user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF s.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status');
  END IF;

  UPDATE public.sparks SET status = 'declined', updated_at = now() WHERE id = _spark_id;

  INSERT INTO public.domain_events (aggregate_type, aggregate_id, event_type, payload)
  VALUES ('spark', _spark_id, 'spark.declined', '{}');

  v_channel := public.user_outbound_channel(s.from_user_id);
  PERFORM public.enqueue_outbound(
    s.from_user_id, v_channel, 'spark_declined', '{}',
    _spark_id::text || ':declined'
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_spark_accept_tx(
  _user_id UUID,
  _spark_id UUID,
  _turn_deadline TIMESTAMPTZ,
  _first_prompt TEXT DEFAULT 'Was hat euch in den letzten Tagen am meisten beschäftigt — und warum?'
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s RECORD;
  v_thread_id UUID;
  v_uid UUID;
  v_channel public.channel_type;
BEGIN
  SELECT * INTO s FROM public.sparks WHERE id = _spark_id FOR UPDATE;
  IF NOT FOUND OR s.to_user_id != _user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF s.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status');
  END IF;

  UPDATE public.sparks SET status = 'accepted', updated_at = now() WHERE id = _spark_id;

  INSERT INTO public.threads (spark_id, user_a, user_b, turn_deadline, facilitator_state)
  VALUES (_spark_id, s.from_user_id, s.to_user_id, _turn_deadline, '{"turn":1}'::jsonb)
  RETURNING id INTO v_thread_id;

  INSERT INTO public.contracts (thread_id, user_a, user_b) VALUES (v_thread_id, s.from_user_id, s.to_user_id);
  INSERT INTO public.thread_turns (thread_id, turn_number, facilitator_prompt)
  VALUES (v_thread_id, 1, _first_prompt);

  INSERT INTO public.domain_events (aggregate_type, aggregate_id, event_type, payload)
  VALUES ('spark', _spark_id, 'spark.accepted', jsonb_build_object('thread_id', v_thread_id));

  FOREACH v_uid IN ARRAY ARRAY[s.from_user_id, s.to_user_id] LOOP
    v_channel := public.user_outbound_channel(v_uid);
    PERFORM public.enqueue_outbound(
      v_uid, v_channel, 'spark_accepted', jsonb_build_object('thread_id', v_thread_id),
      _spark_id::text || ':' || v_uid::text || ':accepted'
    );
    PERFORM public.enqueue_outbound(
      v_uid, v_channel, 'thread_prompt', jsonb_build_object('prompt', _first_prompt),
      v_thread_id::text || ':' || v_uid::text || ':turn1'
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'thread_id', v_thread_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_thread_turn_tx(
  _user_id UUID,
  _thread_id UUID,
  _response TEXT,
  _turn_hours INT DEFAULT 72
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t RECORD;
  turn RECORD;
  v_is_a BOOLEAN;
  v_next_turn INT;
  v_next_prompt TEXT := 'Was würdet ihr beim ersten Treffen gerne herausfinden?';
  v_uid UUID;
  v_channel public.channel_type;
BEGIN
  SELECT * INTO t FROM public.threads WHERE id = _thread_id FOR UPDATE;
  IF NOT FOUND OR t.status != 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_thread');
  END IF;
  IF _user_id NOT IN (t.user_a, t.user_b) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_participant');
  END IF;

  SELECT * INTO turn FROM public.thread_turns
  WHERE thread_id = _thread_id AND turn_number = t.current_turn FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_active_turn');
  END IF;

  v_is_a := (_user_id = t.user_a);
  IF v_is_a THEN
    UPDATE public.thread_turns SET user_a_response = _response, submitted_at_a = now() WHERE id = turn.id;
  ELSE
    UPDATE public.thread_turns SET user_b_response = _response, submitted_at_b = now() WHERE id = turn.id;
  END IF;

  SELECT * INTO turn FROM public.thread_turns WHERE id = turn.id;
  IF turn.user_a_response IS NULL OR turn.user_b_response IS NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'waiting_for_partner');
  END IF;

  IF t.current_turn >= 4 THEN
    UPDATE public.threads SET status = 'ready_for_contract', updated_at = now() WHERE id = _thread_id;
    FOREACH v_uid IN ARRAY ARRAY[t.user_a, t.user_b] LOOP
      v_channel := public.user_outbound_channel(v_uid);
      PERFORM public.enqueue_outbound(
        v_uid, v_channel, 'contract_request', '{}',
        _thread_id::text || ':' || v_uid::text || ':contract'
      );
    END LOOP;
    RETURN jsonb_build_object('success', true, 'message', 'ready_for_contract');
  END IF;

  v_next_turn := t.current_turn + 1;
  UPDATE public.threads SET
    current_turn = v_next_turn,
    turn_deadline = now() + make_interval(hours => _turn_hours),
    updated_at = now()
  WHERE id = _thread_id;

  INSERT INTO public.thread_turns (thread_id, turn_number, facilitator_prompt)
  VALUES (_thread_id, v_next_turn, v_next_prompt);

  FOREACH v_uid IN ARRAY ARRAY[t.user_a, t.user_b] LOOP
    v_channel := public.user_outbound_channel(v_uid);
    PERFORM public.enqueue_outbound(
      v_uid, v_channel, 'thread_prompt', jsonb_build_object('prompt', v_next_prompt),
      _thread_id::text || ':' || v_uid::text || ':turn' || v_next_turn::text
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'turn', v_next_turn);
END;
$$;

-- Fix #4: relay with durable idempotency + client_message_id dedupe
CREATE OR REPLACE FUNCTION public.send_relay_message_tx(
  _sender_user_id UUID,
  _thread_id UUID,
  _body TEXT,
  _client_message_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t RECORD;
  r RECORD;
  v_recipient UUID;
  v_relay_msg_id UUID;
  v_alias TEXT;
  v_channel public.channel_type;
  v_existing UUID;
BEGIN
  SELECT * INTO t FROM public.threads WHERE id = _thread_id;
  IF NOT FOUND OR t.status NOT IN ('revealed', 'date_alignment', 'match_closed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_revealed');
  END IF;
  IF _sender_user_id NOT IN (t.user_a, t.user_b) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_participant');
  END IF;

  SELECT * INTO r FROM public.relay_threads WHERE match_thread_id = _thread_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_relay');
  END IF;

  v_recipient := CASE WHEN _sender_user_id = t.user_a THEN t.user_b ELSE t.user_a END;
  v_alias := CASE WHEN _sender_user_id = t.user_a THEN r.alias_a ELSE r.alias_b END;

  IF _client_message_id IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.relay_messages
    WHERE relay_thread_id = r.id AND client_message_id = _client_message_id;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'relay_message_id', v_existing, 'deduplicated', true);
    END IF;
  END IF;

  INSERT INTO public.relay_messages (relay_thread_id, sender_user_id, body, client_message_id)
  VALUES (r.id, _sender_user_id, _body, _client_message_id)
  RETURNING id INTO v_relay_msg_id;

  INSERT INTO public.messages (thread_id, sender_user_id, body)
  VALUES (_thread_id, _sender_user_id, _body);

  v_channel := public.user_outbound_channel(v_recipient);
  PERFORM public.enqueue_outbound(
    v_recipient,
    v_channel,
    'relay_message',
    jsonb_build_object('alias', v_alias, 'body', _body),
    'relay:' || v_relay_msg_id::text || ':' || v_recipient::text
  );

  RETURN jsonb_build_object('success', true, 'relay_message_id', v_relay_msg_id);
EXCEPTION
  WHEN unique_violation THEN
    SELECT id INTO v_existing FROM public.relay_messages
    WHERE relay_thread_id = r.id AND client_message_id = _client_message_id;
    RETURN jsonb_build_object('success', true, 'relay_message_id', v_existing, 'deduplicated', true);
END;
$$;

-- Extended contract decision with relay + outbox inside transaction
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
  v_uid UUID;
  v_channel public.channel_type;
BEGIN
  SELECT * INTO t FROM public.threads WHERE id = _thread_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'thread_not_found'; END IF;
  IF t.status != 'ready_for_contract' THEN RAISE EXCEPTION 'invalid_thread_status'; END IF;

  SELECT * INTO c FROM public.contracts WHERE thread_id = _thread_id FOR UPDATE;
  is_a := (_user_id = t.user_a);

  IF is_a THEN
    UPDATE public.contracts SET decision_a = _decision, pace_a = _pace WHERE thread_id = _thread_id;
  ELSE
    UPDATE public.contracts SET decision_b = _decision, pace_b = _pace WHERE thread_id = _thread_id;
  END IF;

  SELECT * INTO c FROM public.contracts WHERE thread_id = _thread_id;

  IF c.decision_a IS NOT NULL AND c.decision_b IS NOT NULL THEN
    IF c.decision_a = 'yes' AND c.decision_b = 'yes' THEN
      UPDATE public.threads SET status = 'revealed', revealed_at = now(), updated_at = now()
      WHERE id = _thread_id;
      UPDATE public.contracts SET resolved_at = now() WHERE thread_id = _thread_id;
      UPDATE public.profiles SET reveal_count = reveal_count + 1
      WHERE user_id IN (t.user_a, t.user_b);

      INSERT INTO public.relay_threads (match_thread_id, alias_a, alias_b)
      VALUES (_thread_id, 'Dein Match', 'Dein Match')
      ON CONFLICT (match_thread_id) DO NOTHING;

      FOREACH v_uid IN ARRAY ARRAY[t.user_a, t.user_b] LOOP
        v_channel := public.user_outbound_channel(v_uid);
        PERFORM public.enqueue_outbound(
          v_uid, v_channel, 'reveal_unlocked', '{}',
          _thread_id::text || ':' || v_uid::text || ':reveal'
        );
      END LOOP;

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

-- sparks UNIQUE (round_id, from_user_id, to_user_id) already in 20260524000002_profiles_rounds.sql
