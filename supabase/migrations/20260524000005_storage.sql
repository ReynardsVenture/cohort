-- Profile photo storage (post-reveal access via signed URLs in future phase)

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES
  ('profile-photos-blur', 'profile-photos-blur', false, 5242880),
  ('profile-photos-full', 'profile-photos-full', false, 10485760),
  ('data-exports', 'data-exports', false, 52428800)
ON CONFLICT (id) DO NOTHING;
