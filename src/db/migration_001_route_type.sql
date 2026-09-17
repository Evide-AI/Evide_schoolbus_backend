-- Run this only if you already executed the original schema.sql (i.e. your
-- `routes` table doesn't have route_type yet). If you haven't run schema.sql
-- at all yet, skip this — just use the updated schema.sql directly.

alter table routes add column if not exists route_type text not null default 'pickup' check (route_type in ('pickup', 'drop'));
alter table routes add column if not exists distance_meters double precision;
alter table routes add column if not exists duration_seconds double precision;
alter table routes add constraint routes_bus_id_route_type_key unique (bus_id, route_type);
