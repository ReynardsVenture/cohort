-- Fix #1: Dispatcher lease, delivery_attempts audit, atomic claim with SKIP LOCKED

ALTER TABLE public.outbound_deliveries
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outbound_sending_lease
  ON public.outbound_deliveries (claimed_at)
  WHERE status = 'sending';

DROP INDEX IF EXISTS idx_outbound_pending;
CREATE INDEX idx_outbound_pending ON public.outbound_deliveries (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

INSERT INTO public.cohort_config (key, value) VALUES
  ('dispatcher.sending_lease_minutes', '5')
ON CONFLICT (key) DO NOTHING;

CREATE TYPE public.delivery_attempt_status AS ENUM ('started', 'completed', 'failed');

CREATE TABLE public.delivery_attempts (
  delivery_id UUID NOT NULL REFERENCES public.outbound_deliveries(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL,
  status public.delivery_attempt_status NOT NULL DEFAULT 'started',
  provider_message_id TEXT,
  idempotency_key TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error TEXT,
  PRIMARY KEY (delivery_id, attempt_number)
);

CREATE INDEX idx_delivery_attempts_completed
  ON public.delivery_attempts (delivery_id)
  WHERE status = 'completed' AND provider_message_id IS NOT NULL;

-- Reap stale sending rows (no provider proof of delivery)
CREATE OR REPLACE FUNCTION public.reap_stale_sending_deliveries(_lease interval)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n INT;
BEGIN
  UPDATE public.outbound_deliveries od
  SET
    status = 'failed',
    attempt_count = attempt_count + 1,
    next_attempt_at = now(),
    last_error = 'lease_expired',
    claimed_at = NULL
  WHERE od.status = 'sending'
    AND od.claimed_at IS NOT NULL
    AND od.claimed_at < now() - _lease
    AND od.provider_message_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.delivery_attempts da
      WHERE da.delivery_id = od.id
        AND da.status = 'completed'
        AND da.provider_message_id IS NOT NULL
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Atomically claim a batch via FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION public.claim_outbound_deliveries(
  _batch INT DEFAULT 50,
  _lease_minutes INT DEFAULT 5
)
RETURNS SETOF public.outbound_deliveries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.reap_stale_sending_deliveries(make_interval(mins => _lease_minutes));

  RETURN QUERY
  WITH picked AS (
    SELECT id
    FROM public.outbound_deliveries
    WHERE status IN ('pending', 'failed')
      AND next_attempt_at <= now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT _batch
  )
  UPDATE public.outbound_deliveries od
  SET status = 'sending', claimed_at = now()
  FROM picked
  WHERE od.id = picked.id
  RETURNING od.*;
END;
$$;

-- Mark delivery completed after successful provider call
CREATE OR REPLACE FUNCTION public.complete_outbound_delivery(
  _delivery_id UUID,
  _attempt_number INT,
  _provider_message_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.delivery_attempts
  SET status = 'completed',
      provider_message_id = _provider_message_id,
      completed_at = now()
  WHERE delivery_id = _delivery_id AND attempt_number = _attempt_number;

  UPDATE public.outbound_deliveries
  SET status = 'delivered',
      provider_message_id = _provider_message_id,
      delivered_at = now(),
      last_error = NULL,
      claimed_at = NULL
  WHERE id = _delivery_id;
END;
$$;

-- Repair: provider_message_id already set on delivery row
CREATE OR REPLACE FUNCTION public.repair_outbound_delivered(_delivery_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.outbound_deliveries
  SET status = 'delivered',
      delivered_at = COALESCE(delivered_at, now()),
      claimed_at = NULL
  WHERE id = _delivery_id AND provider_message_id IS NOT NULL;
END;
$$;

-- Fail attempt and schedule retry or dead letter
CREATE OR REPLACE FUNCTION public.fail_outbound_delivery(
  _delivery_id UUID,
  _attempt_number INT,
  _error TEXT,
  _max_attempts INT DEFAULT 8
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt INT;
  v_dead BOOLEAN;
  v_backoff INT[] := ARRAY[1, 5, 30, 120, 240, 480, 720, 1440];
  v_minutes INT;
BEGIN
  UPDATE public.delivery_attempts
  SET status = 'failed', error = left(_error, 500), completed_at = now()
  WHERE delivery_id = _delivery_id AND attempt_number = _attempt_number;

  SELECT attempt_count + 1 INTO v_attempt FROM public.outbound_deliveries WHERE id = _delivery_id;
  v_dead := v_attempt >= _max_attempts;
  v_minutes := v_backoff[LEAST(v_attempt, array_length(v_backoff, 1))];

  UPDATE public.outbound_deliveries
  SET
    status = CASE WHEN v_dead THEN 'dead'::public.outbound_status ELSE 'failed'::public.outbound_status END,
    attempt_count = v_attempt,
    next_attempt_at = CASE WHEN v_dead THEN next_attempt_at ELSE now() + make_interval(mins => v_minutes) END,
    last_error = left(_error, 500),
    claimed_at = NULL
  WHERE id = _delivery_id;
END;
$$;

-- Start a delivery attempt (insert audit row before HTTP call)
CREATE OR REPLACE FUNCTION public.start_delivery_attempt(_delivery_id UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_num INT;
  v_key TEXT;
BEGIN
  SELECT attempt_count + 1, idempotency_key INTO v_num, v_key
  FROM public.outbound_deliveries WHERE id = _delivery_id FOR UPDATE;

  INSERT INTO public.delivery_attempts (delivery_id, attempt_number, status, idempotency_key)
  VALUES (_delivery_id, v_num, 'started', v_key);

  RETURN v_num;
END;
$$;

-- Check for completed attempt (crash recovery — skip re-HTTP)
CREATE OR REPLACE FUNCTION public.outbound_has_completed_attempt(_delivery_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.delivery_attempts
    WHERE delivery_id = _delivery_id
      AND status = 'completed'
      AND provider_message_id IS NOT NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.sync_outbound_from_completed_attempt(_delivery_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pid TEXT;
BEGIN
  SELECT provider_message_id INTO v_pid
  FROM public.delivery_attempts
  WHERE delivery_id = _delivery_id AND status = 'completed' AND provider_message_id IS NOT NULL
  ORDER BY attempt_number DESC LIMIT 1;

  IF v_pid IS NULL THEN RETURN FALSE; END IF;

  UPDATE public.outbound_deliveries
  SET status = 'delivered', provider_message_id = v_pid, delivered_at = now(), claimed_at = NULL
  WHERE id = _delivery_id;

  RETURN TRUE;
END;
$$;
