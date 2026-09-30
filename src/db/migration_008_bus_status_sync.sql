-- Parent app shows Running / Not running from buses.status, and now listens
-- to it live. Add buses to the realtime publication (safe to re-run).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'buses'
  ) then
    alter publication supabase_realtime add table buses;
  end if;
end $$;

-- One-off backfill so existing buses match their current trip.
update buses b set status = 'running'
from trip_state t
where t.bus_id = b.id and t.status = 'IN_PROGRESS' and b.status <> 'maintenance';

update buses b set status = 'not_running'
where b.status = 'running'
  and not exists (select 1 from trip_state t where t.bus_id = b.id and t.status = 'IN_PROGRESS');
