-- ============================================================
-- Allow drivers to send notifications (from the driver app)
-- ============================================================
-- The driver app lets a driver notify parents/management. Notifications are
-- inserted directly by the app, so drivers need an INSERT policy on
-- notifications — scoped to their own bus and school, so a driver can't post
-- to a bus or school they aren't assigned to.

create policy driver_inserts_own_bus_notifications on notifications
  for insert with check (
    bus_id in (select bus_id from drivers where auth_user_id = auth.uid())
    and school_id in (select school_id from drivers where auth_user_id = auth.uid()));
