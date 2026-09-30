import 'dotenv/config';
import express from 'express';
import { startGt06Server } from './gt06/tcpServer.js';
import { evaluateTripState } from './workers/tripStateWorker.js';
import { checkArrivalEtas } from './workers/etaWorker.js';
import { checkTripEvents } from './workers/tripEventsWorker.js';
import { startNotificationWorker } from './workers/notificationWorker.js';
import tripsRouter from './api/routes/trips.js';
import routesRouter from './api/routes/routes.js';

async function main() {
  // Start the FCM notification dispatch worker (consumes the notification queue).
  // Safe to start even without Firebase configured — it just won't send until
  // FIREBASE_SERVICE_ACCOUNT is set.
  try {
    await startNotificationWorker();
  } catch (err) {
    console.error('[FCM] Could not start notification worker:', err.message);
  }

  // --- GT06 GPS ingestion ---
  // Every time a position update comes in, feed it to the trip-state
  // auto-detection logic. Manual start/end from the Driver app happens via
  // the /api/trips route instead and always takes priority.
  startGt06Server(process.env.GT06_TCP_PORT || 5023, {
    onPositionUpdate: async ({ busId, latitude, longitude, speedKmh }) => {
      try {
        await evaluateTripState({ busId, latitude, longitude, speedKmh });
      } catch (err) {
        console.error('[TripState] evaluation failed:', err.message);
      }
      try {
        await checkTripEvents({ busId, latitude, longitude });
      } catch (err) {
        console.error('[TripEvents] check failed:', err.message);
      }
      try {
        await checkArrivalEtas({ busId, latitude, longitude });
      } catch (err) {
        console.error('[ETA] check failed:', err.message);
      }
    },
  });

  // --- API backend ---
  const app = express();
  app.use(express.json());

  // CORS — allow the management dashboard (and Flutter apps) to call the API.
  // ALLOWED_ORIGINS is a comma-separated list in .env; defaults to allowing all
  // if unset (fine for MVP, tighten in production).
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.length === 0 || (origin && allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.use('/api/trips', tripsRouter);
  app.use('/api/routes', routesRouter);

  const apiPort = process.env.API_PORT || 3000;
  app.listen(apiPort, () => {
    console.log(`[API] Express server listening on port ${apiPort}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
