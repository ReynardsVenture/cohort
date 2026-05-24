-- Dev seed (optional)
INSERT INTO public.regions (region_key, status, opened_at) VALUES
  ('berlin', 'open', now())
ON CONFLICT (region_key) DO NOTHING;

INSERT INTO public.entitlements (tier, sparks_per_week, features) VALUES
  ('free', 5, '{}'),
  ('paid', 8, '{"priority_support": true}')
ON CONFLICT (tier) DO NOTHING;
