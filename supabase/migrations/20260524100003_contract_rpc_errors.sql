-- Fix #2: structured domain errors + participant guard on submit_contract_decision

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
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'thread_not_found');
  END IF;
  IF t.status != 'ready_for_contract' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_thread_status');
  END IF;
  IF _user_id NOT IN (t.user_a, t.user_b) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_participant');
  END IF;

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

      RETURN jsonb_build_object('success', true, 'outcome', 'revealed');
    ELSE
      UPDATE public.threads SET status = 'closed', close_reason = 'declined', closed_at = now()
      WHERE id = _thread_id;
      UPDATE public.contracts SET resolved_at = now() WHERE thread_id = _thread_id;
      RETURN jsonb_build_object('success', true, 'outcome', 'declined');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'outcome', 'pending');
END;
$$;
