import { createClient } from '@supabase/supabase-js';

// Uses the service_role key: this backend is a trusted server, so it bypasses
// Row-Level Security. NEVER ship this key inside the Flutter or React apps —
// those use the public anon key instead, which is subject to the RLS policies
// defined in schema.sql.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
