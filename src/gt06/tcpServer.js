import net from 'node:net';
import Gt06 from './gt06.js';
import { isRoadrpaSentence, parseRoadrpa } from './roadrpa.js';
import { supabase } from '../db/supabaseClient.js';
import { touchDevice } from '../utils/deviceRegistry.js';

// In-memory cache of imei -> bus_id so we're not hitting the DB on every ping.
// Rebuilt lazily on cache miss (e.g. after adding a new bus).
// Entries expire, so reassigning a device to another bus in the admin panel
// takes effect within a few minutes without restarting the server.
const CACHE_TTL_MS = 5 * 60 * 1000;
const imeiToBusId = new Map();

async function lookupBusId(imei) {
  const hit = imeiToBusId.get(imei);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.id;

  const { data, error } = await supabase
    .from('buses')
    .select('id')
    .eq('gt06_device_imei', imei)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error(`[GT06] Error looking up bus for IMEI ${imei}:`, error.message);
    return null;
  }
  if (!data) {
    imeiToBusId.delete(imei);
    console.warn(`[GT06] No active bus registered for IMEI ${imei} — ignoring until it's added in the dashboard`);
    return null;
  }

  imeiToBusId.set(imei, { id: data.id, at: Date.now() });
  return data.id;
}

async function writePosition(busId, { latitude, longitude, speedKmh, heading, timestamp }) {
  const record = {
    bus_id: busId,
    latitude,
    longitude,
    speed_kmh: speedKmh,
    heading,
    recorded_at: timestamp.toISOString(),
  };

  const [{ error: liveError }, { error: historyError }] = await Promise.all([
    supabase.from('bus_live_position').upsert(record, { onConflict: 'bus_id' }),
    supabase.from('bus_position_history').insert(record),
  ]);

  if (liveError) console.error('[GT06] Failed to update live position:', liveError.message);
  if (historyError) console.error('[GT06] Failed to insert position history:', historyError.message);
}

export function startGt06Server(port, { onPositionUpdate } = {}) {
  let connectionCount = 0;
  let lastConnectionAt = null;

  const server = net.createServer((socket) => {
    connectionCount += 1;
    lastConnectionAt = new Date();
    const gt06 = new Gt06();
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[GT06] Device connected: ${remote} (connection #${connectionCount})`);

    socket.setTimeout(120000); // 2 min — GT06 heartbeats are usually much more frequent than this
    socket.on('timeout', () => {
      console.warn(`[GT06] Socket from ${remote} timed out with no data for 2 minutes — closing`);
      socket.end();
    });

    socket.on('data', async (data) => {
      console.log(`[GT06] Received ${data.length} bytes from ${remote} | hex: ${data.toString('hex')}`);

      // AIS-140 (ROADRPA) devices send ASCII sentences, not GT06's binary
      // protocol. Not in use yet (GT06 hardware only, for now) — this branch
      // is parked and ready for when AIS-140 devices are added; see
      // roadrpa.js for the integration note.
      if (isRoadrpaSentence(data)) {
        console.log(`[GT06] Detected AIS-140/ROADRPA-style sentence from ${remote}`);
        const parsed = parseRoadrpa(data);
        if (parsed && parsed.valid) {
          const busId = await lookupBusId(parsed.imei);
          if (busId) {
            await writePosition(busId, {
              latitude: parsed.lat,
              longitude: parsed.lon,
              speedKmh: parsed.speed,
              heading: parsed.heading,
              timestamp: parsed.timestamp,
            });
            if (onPositionUpdate) {
              onPositionUpdate({ busId, imei: parsed.imei, latitude: parsed.lat, longitude: parsed.lon, speedKmh: parsed.speed });
            }
          }
        } else {
          console.warn(`[GT06] ROADRPA sentence detected but failed to parse from ${remote}`);
        }
        return;
      }

      let messages;
      try {
        messages = gt06.parse(data);
      } catch (err) {
        console.error(`[GT06] Error parsing data from ${remote}:`, err.message);
        return;
      }

      console.log(`[GT06] Parsed ${messages.length} message(s) from this chunk (${remote})`);
      if (messages.length === 0) {
        console.log(`[GT06] No complete packet yet — likely mid-fragment, waiting for more data from ${remote}`);
      }

      for (const msg of messages) {
        console.log(`[GT06] Message type: 0x${msg.event.number.toString(16).padStart(2, '0')} (${msg.event.string || 'unknown'}) from ${remote}`);

        if (msg.expectsResponse && msg.responseMsg) {
          socket.write(msg.responseMsg);
          console.log(`[GT06] Sent ACK to ${remote}: ${msg.responseMsg.toString('hex')}`);
        }

        if (msg.imei) touchDevice(msg.imei, socket.remoteAddress);

        if (msg.event.number === 0x01 && msg.imei) {
          console.log(`[GT06] Login from IMEI ${msg.imei} (${remote})`);
        }

        if (msg.event.number === 0x16) {
          // Alarm packet — includes SOS, power-cut, shock, geofence events.
          console.log(`[GT06] ALARM from ${msg.imei || 'unknown'}: ${msg.alarmType}`);
          // TODO: once the Driver/Management notification pipeline exists,
          // enqueue an SOS/alarm notification job here keyed on msg.alarmType.
        }

        const isLocation = msg.event.number === 0x12 || msg.event.number === 0x22;
        if (isLocation) {
          console.log(`[GT06] Location packet fields — lat:${msg.lat} lon:${msg.lon} fixTime:${msg.fixTime} imei:${msg.imei}`);
        }
        if (isLocation && msg.lat != null && msg.lon != null && msg.fixTime && msg.imei) {
          const busId = await lookupBusId(msg.imei);
          if (!busId) continue;

          const gps = {
            latitude: msg.lat,
            longitude: msg.lon,
            speedKmh: msg.speed || 0,
            heading: msg.course || 0,
            timestamp: new Date(msg.fixTime),
          };

          console.log(`[GT06] Writing position for bus ${busId}: ${gps.latitude}, ${gps.longitude} @ ${gps.speedKmh}km/h`);
          await writePosition(busId, gps);
          if (onPositionUpdate) {
            onPositionUpdate({ busId, imei: msg.imei, ...gps });
          }
        }
      }

      gt06.clearMsgBuffer();
    });

    socket.on('close', (hadError) => {
      console.log(`[GT06] Device disconnected: ${remote} (IMEI ${gt06.imei || 'unknown'}, hadError: ${hadError})`);
    });

    socket.on('error', (err) => {
      console.error(`[GT06] Socket error from ${remote}:`, err.message);
    });
  });

  server.on('error', (err) => {
    console.error('[GT06] SERVER-LEVEL ERROR:', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`[GT06] Port ${port} is already in use by another process — is another instance of this server already running?`);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    const addr = server.address();
    console.log(`[GT06] TCP server listening on ${addr.address}:${addr.port} (all interfaces)`);
  });

  // Heartbeat so you can tell the process is alive and actually waiting,
  // distinct from "nothing has connected yet".
  setInterval(() => {
    const since = lastConnectionAt ? `last connection at ${lastConnectionAt.toISOString()}` : 'no connections yet since startup';
    console.log(`[GT06] Heartbeat — server alive, ${connectionCount} total connection(s), ${since}`);
  }, 30000);

  return server;
}
