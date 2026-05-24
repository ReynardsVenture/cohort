-- pgTAP-style assertions for local Supabase: supabase test db
-- Requires migrations 20260524100001 and 20260524100002 applied.

BEGIN;

-- Fixtures (minimal)
INSERT INTO public.users (id, age_verified_at, age_verification_method, preferred_outbound_channel)
VALUES
  ('a0000000-0000-4000-8000-000000000001', now(), 'self_declared', 'telegram'),
  ('a0000000-0000-4000-8000-000000000002', now(), 'self_declared', 'telegram')
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

ROLLBACK;
