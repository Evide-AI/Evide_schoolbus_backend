-- ============================================================
-- Trip events: school hours, attendance switch, per-student trip stage,
-- and the current-trip trail for the dashboard map. Safe to re-run.
-- ============================================================

-- 1. Per-school settings (editable in the dashboard "Settings" page) ------
alter table schools add column if not exists attendance_enabled boolean not null default true;
alter table schools add column if not exists morning_start time not null default '06:00';
alter table schools add column if not exists morning_end   time not null default '10:30';
alter table schools add column if not exists evening_start time not null default '14:00';
alter table schools add column if not exists evening_end   time not null default '18:30';

grant update (attendance_enabled, morning_start, morning_end, evening_start, evening_end)
  on schools to authenticated;

drop policy if exists management_updates_own_school on schools;
create policy management_updates_own_school on schools for update
  using (id in (select school_id from management_users where auth_user_id = auth.uid()))
  with check (id in (select school_id from management_users where auth_user_id = auth.uid()));

-- 2. Where each student is on today's trip ---------------------------------
-- Written only by the backend (service_role). Parents read their own
-- children's rows; the parent app uses `stage` to decide what the yellow
-- line should connect (bus -> stop, bus -> school, or nothing).
--   waiting    trip running, bus has not reached the stop yet
--   reached    bus is within 100 m of the stop
--   picked_up  student is on the bus (morning)
--   absent     marked absent after the bus reached the stop
--   at_school  bus reached the school with the student on board (morning)
--   dropped    student got off at their stop (evening)
create table if not exists student_trip_status (
  student_id   uuid not null references students(id) on delete cascade,
  service_date date not null,
  route_type   text not null check (route_type in ('pickup', 'drop')),
  bus_id       uuid references buses(id) on delete cascade,
  stage        text not null default 'waiting'
               check (stage in ('waiting', 'reached', 'picked_up', 'absent', 'at_school', 'dropped')),
  reached_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (student_id, service_date, route_type)
);

alter table student_trip_status enable row level security;
grant select on student_trip_status to authenticated;

drop policy if exists parents_read_trip_status on student_trip_status;
create policy parents_read_trip_status on student_trip_status for select to authenticated
  using (student_id in (select public.my_linked_student_ids()));

do $$ begin
  alter publication supabase_realtime add table student_trip_status;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
alter table student_trip_status replica identity full;

-- 3. Current-trip trail for the dashboard map ------------------------------
-- bus_position_history is backend-only, so management reads it through this
-- function, which checks the bus belongs to the caller's school and returns
-- points only while a trip is running (since it started).
create or replace function bus_trip_trail(p_bus_id uuid)
returns table (latitude double precision, longitude double precision, recorded_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select h.latitude, h.longitude, h.recorded_at
  from bus_position_history h
  join trip_state t on t.bus_id = h.bus_id and t.status = 'IN_PROGRESS'
  join buses b on b.id = h.bus_id
  where h.bus_id = p_bus_id
    and h.recorded_at >= coalesce(t.started_at, now() - interval '3 hours')
    and b.school_id in (select school_id from management_users where auth_user_id = auth.uid())
  order by h.recorded_at
  limit 3000;
$$;

revoke all on function bus_trip_trail(uuid) from public;
grant execute on function bus_trip_trail(uuid) to authenticated;

-- 4. Trip-event notification kinds share notification_log's unique key -----
-- (student, date, route type, kind) so a parent never gets one twice.
-- Kinds used: REACHED_STOP, REACHED_SCHOOL, STUDENT_ABSENT. No schema change needed.

notify pgrst, 'reload schema';
