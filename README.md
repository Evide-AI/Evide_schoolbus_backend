# School Bus Tracking — Backend (V1)

Node.js backend: GT06 GPS ingestion, trip auto-detection, and a small API.
Runs entirely on your laptop for now — no AWS needed until you go live.

**GT06/CRC/geo logic is adapted from your existing Evide backend** (proven
against real hardware), not written from scratch — see "What changed from
Evide's code" below for the one real bug this surfaced and fixed.

## What's in here

```
src/
  gt06/
    gt06.js           # GT06 protocol parser — ported from Evide, with one bug fixed (see below)
    crc16.js           # CRC-16/X-25 — copied unmodified from Evide
    roadrpa.js          # AIS-140 (ROADRPA) parser — ported from Evide, not wired in yet (GT06 hardware only for now)
    tcpServer.js       # TCP server that talks to the physical device, using gt06.js
    gt06.test.js       # Test script — run with `node src/gt06/gt06.test.js` or `npm test`
  routes/
    stopOrdering.js    # Nearest-neighbor stop ordering heuristic
    mapboxClient.js    # Mapbox Directions API client — untested against a real token, see note below
    routeGenerator.js  # Full pipeline: load students/school -> order stops -> call Mapbox -> save route
  utils/
    geoUtils.js        # Haversine distance + ETA calculator — copied unmodified from Evide
  db/
    schema.sql        # Full Supabase/Postgres schema — run this first
    supabaseClient.js # Shared Supabase client (uses service_role key)
  queue/
    queue.js          # pg-boss job queue setup
  workers/
    tripStateWorker.js # Auto-detects trip start/end from GPS movement, with hysteresis (borrowed from Evide's stop-arrival pattern)
  api/
    routes/trips.js   # Manual trip start/end endpoint for the Driver app
  server.js            # Entry point — starts everything
```

## What changed from Evide's code (read this before reusing Evide's gt06.js elsewhere)

Testing `gt06.js` against a GPS packet split across two TCP reads (which
happens routinely over cellular networks) surfaced a real bug: when a packet
starts but hasn't fully arrived yet, the original code treated it the same
as a corrupt packet — advancing past it and slicing off the leading start
byte. That silently breaks reassembly, so that GPS ping is lost. Fixed here
by distinguishing "incomplete" (wait for more data) from "invalid" (skip and
resync) — see the comment in `parse()`/`verifyAndExtractPacket()` in
`gt06.js`. Confirmed with a byte-by-byte fragmentation stress test (3/3
packets recovered, 0 leftover buffer — see `gt06.test.js`).

**Worth backporting this same fix to the live Evide `tcp/handlers/gt06.js`**
— this bug affects that production system too, not just this new project.

## Setup

1. **Run the schema.** Open your Supabase project → SQL Editor → paste the
   contents of `src/db/schema.sql` → Run. This creates every table.

2. **Get your credentials** from Supabase → Project Settings → API (for the
   URL and service_role key) and → Database (for the connection string).

3. **Configure environment variables:**
   ```
   cp .env.example .env
   ```
   Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `DATABASE_URL`.

4. **Install dependencies:**
   ```
   npm install
   ```

5. **Register your first bus** so the ingestion server knows which bus an
   incoming IMEI belongs to. Easiest way for now: in the Supabase Table
   Editor, add a row to `schools` (with latitude/longitude set — the trip
   auto-detection needs this), then a row to `buses` with
   `gt06_device_imei` set to your physical device's IMEI.

6. **Start the server:**
   ```
   npm start
   ```
   You should see:
   ```
   [GT06] TCP server listening on port 5023
   [API] Express server listening on port 3000
   [pg-boss] queue started
   ```

7. **Point your GT06 device at this server.** GT06 devices are configured via
   SMS command (varies by manufacturer, commonly something like
   `SERVER,0,<your-ip>,5023,0#` sent to the device's SIM number) to set the
   server IP and port. Since your laptop is likely on a private/NAT'd network,
   the device needs to reach it — for bench testing on the same Wi-Fi network,
   use your laptop's local IP; for anything remote, you'll need a tunnel
   (Cloudflare Tunnel or ngrok) pointed at port 5023.

8. **Watch the console.** On device login you'll see
   `[GT06] Login from IMEI ...` — if that IMEI doesn't match a bus in your
   database yet, you'll see a warning telling you to add it. Once matched,
   GPS packets will start writing to `bus_live_position` and
   `bus_position_history` — check the Supabase Table Editor to confirm rows
   are appearing.

## Testing without the physical device (recommended first step)

Before fighting with tunnels/networking at all, validate your whole pipeline
locally using a simulated GT06 device — no hardware, no internet exposure
needed:

1. In Supabase, add a `schools` row with `latitude`/`longitude` set, and a
   `buses` row with `gt06_device_imei = '864404031234567'` (the simulator's
   default IMEI) and `is_active = true`.
2. Start your server as usual: `npm start`
3. In a second terminal: `npm run simulate`

This connects to your server exactly like a real device would — sends a
login packet, then simulates a bus driving from a "home" point toward your
school over ~90 seconds, then sitting still at the school for ~200 seconds.
That's long enough to exercise the **trip auto-detection logic** too (crosses
both the 60s movement threshold and the 180s stationary threshold from
`tripStateWorker.js`), not just raw position writes.

Watch for in your `npm start` terminal:
- `[GT06] Login from IMEI 864404031234567`
- A stream of parsed GPS location packets
- After ~90s of simulated movement: the trip auto-starting (check the
  `trip_state` table in Supabase, or watch for the `BUS_STARTED` job in your
  `npm start` logs)
- After ~200s stationary: the trip auto-ending (`BUS_REACHED`)

Also check Supabase's Table Editor directly — `bus_live_position` should
show the moving/final position, and `bus_position_history` should
accumulate a row per simulated ping.

Edit `HOME`/`SCHOOL` coordinates and `SIM_IMEI` at the top of
`scripts/simulateGt06Device.js` to match your real test data. The real
device/network connectivity (tunnel, cloud deployment, etc.) can be solved
separately once you've confirmed the backend itself works end-to-end.

## Before trusting this against your real device

Uncomment the raw hex logging line in `tcpServer.js` for your first real
session, and compare the parsed latitude/longitude/speed against a known
reference (e.g. your phone's GPS at the same spot). The core decode logic
(`decodeGt06Lat`/`decodeGt06Lon` in `gt06.js`) is the same one already
running against your ~40 Evide buses, so it should hold up — but always
worth a sanity check on real data before going live.

## Running the tests

No device or Supabase connection needed — validates packet framing, parsing,
CRC/ACK logic, and the split-packet fix against synthetic data:

```
npm test
```

## What's not built yet

This covers Phase 0-4 of the roadmap (setup, DB schema, GT06 ingestion,
job queue + trip-state worker, route generation). Still to build: the
Parent/Driver Flutter apps and the React management dashboard — happy to
keep going on either next.

## Route generation — what's tested and what isn't

The **stop-ordering logic** (`stopOrdering.js`) and the **pickup/drop
waypoint sequencing** (`routeGenerator.js`'s `buildWaypointSequence`) are
both tested against synthetic coordinates and behave correctly — pickup
routes end at school, drop routes start at school, stops order sensibly by
distance.

The **actual Mapbox Directions API call** (`mapboxClient.js`) is *not*
tested end-to-end — this sandbox has no network access to api.mapbox.com.
The request follows Mapbox's documented Directions API v5 shape, but verify
it against your real `MAPBOX_ACCESS_TOKEN` before trusting it:

```
curl -X POST http://localhost:3000/api/routes/<bus-id>/generate \
  -H "Content-Type: application/json" \
  -d '{"type":"pickup"}'
```

If Mapbox's response shape differs from what's expected, the error message
from `fetchRoadRoute` will surface Mapbox's actual error text to help debug.

To generate both pickup and drop in one call, omit `"type"` from the body.

