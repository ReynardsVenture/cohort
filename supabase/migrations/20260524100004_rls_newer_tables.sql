-- Fix #4: RLS on server-only tables (deny-by-default for anon/authenticated clients)

ALTER TABLE public.relay_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_attempts ENABLE ROW LEVEL SECURITY;

-- No client policies: access via service_role and SECURITY DEFINER RPCs only.
-- relay_threads / relay_messages hold mediated chat content — never client-readable.
