-- ============================================================
-- FIX: management write access (INSERT / UPDATE / DELETE)
-- ============================================================
-- The original policies only granted managers SELECT on buses/students, which
-- is why reads worked but "Add bus" failed with:
--   "new row violates row-level security policy for table buses"
-- These policies grant managers full write access, scoped to THEIR school only.
-- Run this whole block in the Supabase SQL editor.

-- A helper predicate is repeated inline (RLS can't use functions cleanly here):
-- "the row's school_id is one this signed-in manager belongs to".

-- ---------- BUSES ----------
create policy management_inserts_school_buses on buses
  for insert with check (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  );

create policy management_updates_school_buses on buses
  for update using (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  ) with check (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  );

create policy management_deletes_school_buses on buses
  for delete using (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  );

-- ---------- STUDENTS ----------
create policy management_inserts_school_students on students
  for insert with check (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  );

create policy management_updates_school_students on students
  for update using (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  ) with check (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  );

create policy management_deletes_school_students on students
  for delete using (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  );

-- ---------- NOTIFICATIONS ----------
-- Managers create notifications for their school (the "Send notification" button).
create policy management_inserts_school_notifications on notifications
  for insert with check (
    school_id in (select school_id from management_users where auth_user_id = auth.uid())
  );
