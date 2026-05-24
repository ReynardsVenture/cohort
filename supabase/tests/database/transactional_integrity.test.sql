-- pgTAP-style assertions for local Supabase: supabase test db
-- Requires migrations through 20260524100004 applied.

BEGIN;

-- Fixtures (minimal)
INSERT INTO public.users (id, age_verified_at, age_verification_method, preferred_outbound_channel)
VALUES
  ('a0000000-0000-4000-8000-000000000001', now(), 'self_declared', 'telegram'),
  ('a0000000-0000-4000-8000-000000000002', now(), 'self_declared', 'telegram'),
  ('a0000000-0000-4000-8000-000000000003', now(), 'self_declared', 'telegram'),
  ('a0000000-0000-4000-8000-000000000004', now(), 'self_declared', 'telegram'),
  ('a0000000-0000-4000-8000-000000000005', now(), 'self_declared', 'telegram'),
  ('a0000000-0000-4000-8000-000000000006', now(), 'self_declared', 'telegram'),
  ('a0000000-0000-4000-8000-000000000007', now(), 'self_declared', 'telegram')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.regions (region_key, status, opened_at)
VALUES ('berlin', 'open', now()) ON CONFLICT DO NOTHING;

INSERT INTO public.weekly_rounds (id, region_key, intent_lane, lane_type, match_key, week_start, week_end, status)
VALUES (
  'b0000000-0000-4000-8000-000000000001',
  'berlin', 'serious', 'straight', 'test:straight:2026-01-01',
  '2026-01-01', '2026-01-07', 'active'
) ON CONFLICT DO NOTHING;

INSERT INTO public.weekly_quotas (user_id, round_id, sparks_sent, sparks_budget)
VALUES ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 0, 5)
ON CONFLICT (user_id, round_id) DO UPDATE SET sparks_sent = 0, sparks_budget = 5;

-- Budget exhausted should fail without spark row
UPDATE public.weekly_quotas SET sparks_sent = 5
WHERE user_id = 'a0000000-0000-4000-8000-000000000001';

DO $$
DECLARE
  r JSONB;
  spark_count INT;
BEGIN
  r := public.send_spark_tx(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000001',
    'curious',
    'This is a test spark message!!',
    'explore',
    now() + interval '48 hours'
  );
  IF (r->>'success')::boolean THEN
    RAISE EXCEPTION 'expected budget failure, got success';
  END IF;
  IF r->>'error' != 'spark_budget_exceeded' THEN
    RAISE EXCEPTION 'expected spark_budget_exceeded, got %', r->>'error';
  END IF;
  SELECT count(*) INTO spark_count FROM public.sparks
  WHERE from_user_id = 'a0000000-0000-4000-8000-000000000001'
    AND round_id = 'b0000000-0000-4000-8000-000000000001';
  IF spark_count > 0 THEN
    RAISE EXCEPTION 'orphan spark rows after budget failure: %', spark_count;
  END IF;
END $$;

-- Reset quota: exactly 5 of 6 sequential sends succeed
UPDATE public.weekly_quotas SET sparks_sent = 0, sparks_budget = 5
WHERE user_id = 'a0000000-0000-4000-8000-000000000001';

DO $$
DECLARE
  i INT;
  r JSONB;
  ok_count INT := 0;
  fail_count INT := 0;
  targets UUID[] := ARRAY[
    'a0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000004',
    'a0000000-0000-4000-8000-000000000005',
    'a0000000-0000-4000-8000-000000000006',
    'a0000000-0000-4000-8000-000000000007'
  ];
BEGIN
  FOR i IN 1..6 LOOP
    r := public.send_spark_tx(
      'a0000000-0000-4000-8000-000000000001',
      targets[i],
      'b0000000-0000-4000-8000-000000000001',
      'curious',
      'Sequential spark message number ' || i || '!!',
      'explore',
      now() + interval '48 hours'
    );
    IF (r->>'success')::boolean THEN
      ok_count := ok_count + 1;
    ELSE
      fail_count := fail_count + 1;
      IF r->>'error' != 'spark_budget_exceeded' AND r->>'error' != 'duplicate_spark' THEN
        RAISE EXCEPTION 'unexpected error on send %: %', i, r->>'error';
      END IF;
    END IF;
  END LOOP;
  IF ok_count != 5 THEN
    RAISE EXCEPTION 'expected 5 successful sparks, got %', ok_count;
  END IF;
  IF fail_count != 1 THEN
    RAISE EXCEPTION 'expected 1 failed spark, got %', fail_count;
  END IF;
END $$;

-- Duplicate spark to same recipient in same round
DO $$
DECLARE
  r JSONB;
BEGIN
  r := public.send_spark_tx(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000001',
    'curious',
    'Duplicate spark attempt message!!',
    'explore',
    now() + interval '48 hours'
  );
  IF (r->>'success')::boolean THEN
    RAISE EXCEPTION 'expected duplicate_spark failure';
  END IF;
  IF r->>'error' != 'duplicate_spark' THEN
    RAISE EXCEPTION 'expected duplicate_spark, got %', r->>'error';
  END IF;
END $$;

-- Relay dedupe: same client_message_id → one row, deduplicated on second call
INSERT INTO public.sparks (id, round_id, from_user_id, to_user_id, style, message, intent_level, status, expires_at)
VALUES (
  'c0000000-0000-4000-8000-000000000099',
  'b0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000007',
  'curious', 'fixture spark for relay', 'explore', 'pending', now() + interval '48 hours'
) ON CONFLICT DO NOTHING;

INSERT INTO public.threads (id, spark_id, user_a, user_b, status, revealed_at)
VALUES (
  'd0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000099',
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000007',
  'revealed',
  now()
) ON CONFLICT DO NOTHING;

INSERT INTO public.relay_threads (id, match_thread_id, alias_a, alias_b)
VALUES (
  'e0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'A', 'B'
) ON CONFLICT DO NOTHING;

DO $$
DECLARE
  r1 JSONB;
  r2 JSONB;
  msg_count INT;
BEGIN
  r1 := public.send_relay_message_tx(
    'a0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'Hello relay',
    'client-dedupe-1'
  );
  IF NOT (r1->>'success')::boolean THEN
    RAISE EXCEPTION 'first relay send failed: %', r1->>'error';
  END IF;

  r2 := public.send_relay_message_tx(
    'a0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'Hello relay',
    'client-dedupe-1'
  );
  IF NOT (r2->>'success')::boolean OR NOT (r2->>'deduplicated')::boolean THEN
    RAISE EXCEPTION 'second relay should be deduplicated: %', r2;
  END IF;

  SELECT count(*) INTO msg_count FROM public.relay_messages
  WHERE relay_thread_id = 'e0000000-0000-4000-8000-000000000001'
    AND client_message_id = 'client-dedupe-1';
  IF msg_count != 1 THEN
    RAISE EXCEPTION 'expected 1 relay_messages row, got %', msg_count;
  END IF;
END $$;

ROLLBACK;
