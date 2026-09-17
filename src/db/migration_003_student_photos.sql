-- ============================================================
-- Student profile photos (optional)
-- ============================================================
-- Stores the storage path of an uploaded photo (not a public URL). The apps
-- generate short-lived signed URLs from this path to display the image, so
-- children's photos are never on a publicly-guessable link.

alter table students add column if not exists photo_path text;

-- ------------------------------------------------------------
-- STORAGE BUCKET SETUP (do this in the Supabase dashboard, once)
-- ------------------------------------------------------------
-- 1. Supabase Dashboard -> Storage -> New bucket
--      Name:   student-photos
--      Public: OFF  (leave it private)
--    Create it.
--
-- 2. Then run the storage policies below in the SQL editor. They let any
--    signed-in user of THIS project read/write objects in the bucket. Because
--    the bucket is private, images are only reachable via signed URLs the app
--    generates — a raw link won't work without a valid session.
--
--    (For the MVP these policies scope by "authenticated", matching how the
--    rest of the app trusts logged-in school staff/drivers. Tightening photo
--    access per-school is a later refinement if ever needed.)

-- Allow authenticated users to upload/replace photos in the bucket
create policy "authenticated can upload student photos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'student-photos');

create policy "authenticated can update student photos"
  on storage.objects for update to authenticated
  using (bucket_id = 'student-photos');

create policy "authenticated can read student photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'student-photos');

create policy "authenticated can delete student photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'student-photos');
