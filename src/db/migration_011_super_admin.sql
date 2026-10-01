-- ============================================================
-- Super admin panel: platform owner access across all schools.
-- Safe to re-run.
--
-- BEFORE running: create the login in Supabase
--   Authentication > Users > Add user > admin@evide.in (with a password).
-- This file then registers that account as the only super admin.
-- The address is set in ONE place below (v_email). If your login uses a
-- different address, change it there and nowhere else.
-- ============================================================

-- 1. Who is a super admin -----------------------------------------------
create table if not exists super_admins (
  auth_user_id uuid primary key,
  email        text not null,
  created_at   timestamptz not null default now()
);
alter table super_admins enable row level security;
grant select on super_admins to authenticated;

drop policy if exists super_admin_reads_self on super_admins;
create policy super_admin_reads_self on super_admins for select to authenticated
  using (auth_user_id = auth.uid());

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from super_admins where auth_user_id = auth.uid());
$$;
revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated;

do $$
declare
  v_email text := 'admin@evide.in';   -- the one and only super admin
  uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(v_email) limit 1;
  if uid is null then
    raise notice '% was not found in Supabase Auth. Create that user first (Authentication > Users > Add user), then run this file again.', v_email;
  else
    insert into super_admins (auth_user_id, email) values (uid, v_email)
    on conflict (auth_user_id) do nothing;
    raise notice '% is now a super admin.', v_email;
  end if;
end $$;

-- 2. Plan / billing per school (super admin only, schools never see it) ----
create table if not exists school_billing (
  school_id     uuid primary key references schools(id) on delete cascade,
  plan_name     text,
  plan_status   text not null default 'trial' check (plan_status in ('trial', 'active', 'suspended')),
  price_amount  numeric(12, 2),
  price_unit    text check (price_unit in ('per_school', 'per_bus', 'per_student')),
  billing_start date,
  renewal_date  date,
  contact_name  text,
  contact_phone text,
  contact_email text,
  admin_notes   text,
  updated_at    timestamptz not null default now()
);
alter table school_billing enable row level security;
grant select, insert, update, delete on school_billing to authenticated;

drop policy if exists super_admin_all on school_billing;
create policy super_admin_all on school_billing for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- Schools that already exist are live customers.
insert into school_billing (school_id, plan_status)
select id, 'active' from schools
on conflict (school_id) do nothing;

-- 3. GT06 devices seen by the server, and push failures, and admin actions ---
create table if not exists gt06_devices (
  imei       text primary key,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  last_ip    text
);
alter table gt06_devices enable row level security;
create table if not exists push_failures (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  category      text,
  bus_id        uuid,
  error_code    text,
  error_message text,
  failed_count  int not null default 1
);
create index if not exists idx_push_failures_time on push_failures(created_at desc);
alter table push_failures enable row level security;

create table if not exists admin_audit (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  admin_user_id uuid,
  admin_email   text,
  action        text not null,
  target_type   text,
  target_id     text,
  details       jsonb
);
create index if not exists idx_admin_audit_time on admin_audit(created_at desc);
alter table admin_audit enable row level security;

-- 4. Super admin can read everything (added on top of the existing rules) ---
do $$
declare t text;
begin
  foreach t in array array[
    'schools', 'buses', 'students', 'drivers', 'management_users', 'routes',
    'bus_live_position', 'trip_history', 'trip_state', 'notifications',
    'notification_log', 'parent_users', 'parent_student_links', 'attendance',
    'gt06_devices', 'push_failures', 'admin_audit'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('grant select on public.%I to authenticated', t);
      execute format('drop policy if exists super_admin_read on public.%I', t);
      execute format('create policy super_admin_read on public.%I for select to authenticated using (public.is_super_admin())', t);
    end if;
  end loop;
end $$;

grant insert on admin_audit to authenticated;
grant usage, select on sequence admin_audit_id_seq to authenticated;
drop policy if exists super_admin_writes_audit on admin_audit;
create policy super_admin_writes_audit on admin_audit for insert to authenticated
  with check (public.is_super_admin());

-- 5. Actions that change other tables go through functions, so the school
--    dashboards' own permissions are not widened. -------------------------
create or replace function admin_save_school(
  p_id uuid, p_name text, p_address text, p_lat double precision, p_lng double precision
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not is_super_admin() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'School name is required'; end if;

  if p_id is null then
    insert into schools (name, address, latitude, longitude)
    values (trim(p_name), nullif(trim(coalesce(p_address, '')), ''), p_lat, p_lng)
    returning id into v_id;
    insert into school_billing (school_id) values (v_id) on conflict do nothing;
  else
    update schools
       set name = trim(p_name), address = nullif(trim(coalesce(p_address, '')), ''),
           latitude = p_lat, longitude = p_lng
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'School not found'; end if;
  end if;

  insert into admin_audit (admin_user_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), auth.jwt() ->> 'email',
          case when p_id is null then 'school.create' else 'school.update' end,
          'school', v_id::text, jsonb_build_object('name', trim(p_name)));
  return v_id;
end $$;
revoke all on function admin_save_school(uuid, text, text, double precision, double precision) from public;
grant execute on function admin_save_school(uuid, text, text, double precision, double precision) to authenticated;

create or replace function admin_set_bus_imei(p_bus_id uuid, p_imei text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_imei  text := nullif(regexp_replace(coalesce(p_imei, ''), '\s', '', 'g'), '');
  v_other text;
begin
  if not is_super_admin() then raise exception 'Not allowed'; end if;
  if v_imei is not null and v_imei !~ '^\d{15}$' then
    raise exception 'A GT06 device number (IMEI) is exactly 15 digits';
  end if;
  if v_imei is not null then
    select b.bus_number || ' (' || s.name || ')' into v_other
      from buses b join schools s on s.id = b.school_id
     where b.gt06_device_imei = v_imei and b.id <> p_bus_id;
    if v_other is not null then raise exception 'That device is already assigned to %', v_other; end if;
  end if;

  update buses set gt06_device_imei = v_imei where id = p_bus_id;
  if not found then raise exception 'Bus not found'; end if;

  insert into admin_audit (admin_user_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), auth.jwt() ->> 'email', 'bus.imei', 'bus', p_bus_id::text,
          jsonb_build_object('imei', v_imei));
end $$;
revoke all on function admin_set_bus_imei(uuid, text) from public;
grant execute on function admin_set_bus_imei(uuid, text) to authenticated;

-- 6. Numbers for the Overview page and the Schools list ------------------
create or replace function admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not is_super_admin() then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'schools',          (select count(*) from schools),
    'buses',            (select count(*) from buses where is_active),
    'running_buses',    (select count(*) from buses where is_active and status = 'running'),
    'students',         (select count(*) from students),
    'parents',          (select count(*) from parent_users),
    'school_logins',    (select count(*) from management_users),
    'trips_today',      (select count(*) from trip_history where service_date = today),
    'notifications_24h',(select count(*) from notifications where created_at > now() - interval '24 hours'),
    'push_failures_24h',(select coalesce(sum(failed_count), 0) from push_failures where created_at > now() - interval '24 hours')
  );
end $$;
revoke all on function admin_overview() from public;
grant execute on function admin_overview() to authenticated;

create or replace function admin_school_stats()
returns table (school_id uuid, buses bigint, running bigint, students bigint, parents bigint, logins bigint)
language sql
stable
security definer
set search_path = public
as $$
  select s.id,
    (select count(*) from buses b where b.school_id = s.id and b.is_active),
    (select count(*) from buses b where b.school_id = s.id and b.is_active and b.status = 'running'),
    (select count(*) from students st where st.school_id = s.id),
    (select count(distinct l.parent_user_id) from parent_student_links l
       join students st on st.id = l.student_id where st.school_id = s.id),
    (select count(*) from management_users m where m.school_id = s.id)
  from schools s
  where is_super_admin();
$$;
revoke all on function admin_school_stats() from public;
grant execute on function admin_school_stats() to authenticated;

notify pgrst, 'reload schema';
