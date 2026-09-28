-- ============================================================
-- Parents see only their own children's notifications
-- ============================================================
-- Bug: a parent could read attendance notifications ("Irfan boarded the bus")
-- for OTHER students on the same bus. The old policy only checked school and
-- bus, so any student-specific row on a shared bus leaked to every parent on
-- that bus.
--
-- New rule for a parent:
--   * a row tied to a student (student_id set)  -> only if that student is
--     linked to this parent
--   * a general row (student_id null)          -> school/bus match as before,
--     and not an office-only message
--
-- Postgres ORs permissive policies together, so ANY older parent SELECT
-- policy left on the table would keep leaking. The DO block below removes
-- every SELECT/ALL policy on notifications that references parent tables,
-- then creates the single correct one. Management and driver policies are
-- untouched (they reference management_users / drivers, not parent tables).

-- Helper: the student ids linked to the signed-in parent.
-- SECURITY DEFINER so it isn't itself blocked by RLS on the link tables;
-- it only ever returns the caller's own children.
create or replace function public.my_linked_student_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select psl.student_id
  from parent_student_links psl
  join parent_users pu on pu.id = psl.parent_user_id
  where pu.auth_user_id = auth.uid()
$$;

revoke all on function public.my_linked_student_ids() from public;
grant execute on function public.my_linked_student_ids() to authenticated;

do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'notifications'
      and cmd in ('SELECT', 'ALL')
      and (coalesce(qual, '') ilike '%parent_%')
  loop
    raise notice 'Dropping parent policy on notifications: %', p.policyname;
    execute format('drop policy %I on public.notifications', p.policyname);
  end loop;
end $$;

create policy parent_sees_own_children_notifications on notifications
  for select to authenticated
  using (
    case
      -- Student-specific (attendance, absent, ETA, etc.): own children only.
      when student_id is not null then
        student_id in (select public.my_linked_student_ids())

      -- General message: same school, whole-school or own child's bus,
      -- and not an office-only message.
      else
        coalesce(audience, 'parents') <> 'management'
        and school_id in (
          select st.school_id from students st
          where st.id in (select public.my_linked_student_ids())
        )
        and (
          bus_id is null
          or bus_id in (
            select st.bus_id from students st
            where st.id in (select public.my_linked_student_ids())
          )
        )
    end
  );

create index if not exists idx_notifications_student on notifications(student_id);

-- Verify afterwards (should list exactly ONE parent policy, the new one):
--   select policyname, cmd, qual from pg_policies
--   where tablename = 'notifications' order by policyname;
