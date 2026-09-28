-- ============================================================
-- ETA-based "bus arriving in ~10 minutes" notifications
-- ============================================================
-- Replaces the fixed 500m proximity alarm with a time-based alert. Three
-- backend-only tables (RLS enabled, zero policies — only the Node backend
-- touches them via service_role):
--
--   route_segment_stats — learned stop-to-stop travel times
--   trip_progress       — which stops a bus has reached on today's trip
--   notification_log    — one row per alert sent; stops duplicates, survives restarts

-- Learned travel time between two consecutive stops. Keyed by the stops'
-- rounded coordinates (not their sequence number), so the learning survives
-- a route regeneration as long as those two stops are still neighbours.
-- avg_seconds INCLUDES boarding time at the "from" stop.
create table if not exists route_segment_stats (
  bus_id uuid not null references buses(id) on delete cascade,
  route_type text not null check (route_type in ('pickup', 'drop')),
  segment_key text not null,          -- "lat,lng>lat,lng" rounded to 4 decimals (~11m)
  avg_seconds double precision not null,
  samples int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bus_id, route_type, segment_key)
);

-- Progress of today's trip. Written only when the bus reaches a stop
-- (not on every ping), so it's cheap, and it lets the backend resume
-- correctly after a restart mid-trip.
create table if not exists trip_progress (
  bus_id uuid not null references buses(id) on delete cascade,
  service_date date not null,         -- IST date
  route_type text not null check (route_type in ('pickup', 'drop')),
  visited jsonb not null default '{}'::jsonb,  -- { "<stop sequence>": "<ISO time reached>" }
  anchor_index int,                   -- sequence of the most recent stop reached
  anchor_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (bus_id, service_date, route_type)
);

-- One row per student per trip per alert kind. The unique key is what
-- guarantees a parent never gets the same alert twice for the same trip.
create table if not exists notification_log (
  id bigserial primary key,
  student_id uuid not null references students(id) on delete cascade,
  bus_id uuid references buses(id) on delete set null,
  service_date date not null,
  route_type text not null check (route_type in ('pickup', 'drop')),
  kind text not null default 'ARRIVING_SOON',
  eta_seconds int,
  sent_at timestamptz not null default now(),
  unique (student_id, service_date, route_type, kind)
);

create index if not exists idx_notification_log_date on notification_log(service_date);

alter table route_segment_stats enable row level security;
alter table trip_progress enable row level security;
alter table notification_log enable row level security;
