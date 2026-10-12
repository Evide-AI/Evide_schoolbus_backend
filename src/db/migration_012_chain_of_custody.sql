-- ============================================================
-- Chain of custody: "bus checked empty" after every school trip, and an
-- alert when nobody confirms it. Safe to re-run.
--
-- Flow:
--   1. A pickup or drop trip ends (bus parked at school).
--   2. The driver/conductor walks to the back of the bus and taps
--      "Bus checked empty" in the driver app
--      -> POST /api/trips/:busId/empty-check -> trip_history.empty_checked_at
--   3. If nobody taps it within EMPTY_CHECK_MINUTES (default 10) of the trip
--      ending, the backend writes a row to bus_safety_alerts (dashboard) and
--      pushes the bus's driver/conductor phones.
--
-- The new parent notifications (PICKED_UP, LEFT_SCHOOL, DROPPED_HOME) use
-- the existing notifications + notification_log tables. No change needed.
-- ============================================================

-- 1. Empty-check fields on each trip ----------------------------------------
alter table trip_history add column if not exists empty_checked_at timestamptz;
alter table trip_history add column if not exists empty_checked_by text;   -- driver / conductor / management
alter table trip_history add column if not exists empty_alert_at   timestamptz;

-- The sweeper looks for recently ended school trips that were never checked.
create index if not exists idx_trip_history_unchecked
  on trip_history(ended_at)
  where empty_checked_at is null and empty_alert_at is null;

-- 2. Safety alerts for the school office -------------------------------------
-- Kept separate from `notifications` on purpose: parents must never see these,
-- and nothing here should go through the parent push trigger.
create table if not exists bus_safety_alerts (
  id              bigserial primary key,
  school_id       uuid not null references schools(id) on delete cascade,
  bus_id          uuid not null references buses(id) on delete cascade,
  trip_id         bigint references trip_history(id) on delete set null,
  kind            text not null check (kind in ('EMPTY_CHECK_MISSED')),
  title           text not null,
  body            text not null,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,     -- set when the bus is checked, or by management
  resolved_by     text
);

create index if not exists idx_bus_safety_alerts_school_time
  on bus_safety_alerts(school_id, created_at desc);

alter table bus_safety_alerts enable row level security;
grant select, update (resolved_at, resolved_by) on bus_safety_alerts to authenticated;

drop policy if exists management_reads_safety_alerts on bus_safety_alerts;
create policy management_reads_safety_alerts on bus_safety_alerts for select to authenticated
  using (school_id in (select school_id from management_users where auth_user_id = auth.uid()));

drop policy if exists management_resolves_safety_alerts on bus_safety_alerts;
create policy management_resolves_safety_alerts on bus_safety_alerts for update to authenticated
  using (school_id in (select school_id from management_users where auth_user_id = auth.uid()))
  with check (school_id in (select school_id from management_users where auth_user_id = auth.uid()));

-- Super admin can read these too (same rule migration_011 added elsewhere).
do $$ begin
  if exists (select 1 from pg_proc where proname = 'is_super_admin') then
    execute 'drop policy if exists super_admin_read on bus_safety_alerts';
    execute 'create policy super_admin_read on bus_safety_alerts for select to authenticated using (public.is_super_admin())';
  end if;
end $$;

-- The dashboard listens for new alerts live.
do $$ begin
  alter publication supabase_realtime add table bus_safety_alerts;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
alter table bus_safety_alerts replica identity full;

notify pgrst, 'reload schema';
