-- ============================================================
-- FCM device tokens (for push notifications to parents)
-- ============================================================
-- Each parent device registers its Firebase Cloud Messaging token here so the
-- backend can send push notifications (including the 500m proximity alarm).
-- One parent may have several devices; tokens can change, so we upsert on the
-- token itself.

create table if not exists device_tokens (
  id uuid primary key default uuid_generate_v4(),
  parent_user_id uuid not null references parent_users(id) on delete cascade,
  fcm_token text not null unique,
  platform text,                       -- 'android' | 'ios'
  updated_at timestamptz not null default now()
);

create index if not exists idx_device_tokens_parent on device_tokens(parent_user_id);

alter table device_tokens enable row level security;

-- A parent manages only their own device tokens (register/refresh/remove).
create policy parent_manages_own_tokens on device_tokens
  for all using (
    parent_user_id in (select id from parent_users where auth_user_id = auth.uid())
  ) with check (
    parent_user_id in (select id from parent_users where auth_user_id = auth.uid())
  );
