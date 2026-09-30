-- ============================================================
-- Trip history: one row per trip, so the dashboard can show the live trip
-- and a list of recent trips per bus. Safe to re-run.
-- ============================================================

create table if not exists trip_history (
  id           bigserial primary key,
  bus_id       uuid not null references buses(id) on delete cascade,
  school_id    uuid not null references schools(id) on delete cascade,
  service_date date not null,
  -- pickup = morning window, drop = evening window, other = outside school hours
  route_type   text not null check (route_type in ('pickup', 'drop', 'other')),
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,             -- null = trip still running
  started_by   text,                    -- driver / conductor / auto / management
  ended_by     text                     -- ... or auto-silent / auto-expire / superseded
);

create index if not exists idx_trip_history_bus_time on trip_history(bus_id, started_at desc);
create index if not exists idx_trip_history_open on trip_history(bus_id) where ended_at is null;

alter table trip_history enable row level security;
grant select on trip_history to authenticated;

drop policy if exists management_reads_trip_history on trip_history;
create policy management_reads_trip_history on trip_history for select to authenticated
  using (school_id in (select school_id from management_users where auth_user_id = auth.uid()));

-- The dashboard map listens for trips starting and ending.
do $$ begin
  alter publication supabase_realtime add table trip_history;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
alter table trip_history replica identity full;

-- Where the bus actually drove during one recorded trip. bus_position_history
-- is backend-only, so management reads it through this function, which checks
-- the trip belongs to the caller's school.
create or replace function trip_history_trail(p_trip_id bigint)
returns table (latitude double precision, longitude double precision, recorded_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select h.latitude, h.longitude, h.recorded_at
  from trip_history t
  join bus_position_history h on h.bus_id = t.bus_id
   and h.recorded_at >= t.started_at
   and h.recorded_at <= coalesce(t.ended_at, now())
  where t.id = p_trip_id
    and t.school_id in (select school_id from management_users where auth_user_id = auth.uid())
  order by h.recorded_at
  limit 6000;
$$;

revoke all on function trip_history_trail(bigint) from public;
grant execute on function trip_history_trail(bigint) to authenticated;

notify pgrst, 'reload schema';
