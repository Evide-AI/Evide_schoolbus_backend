import express from 'express';
import { generateRouteForBus } from '../../routes/routeGenerator.js';
import { invalidateBusCache } from '../../workers/etaWorker.js';

const router = express.Router();

// Called by the management dashboard after a student is added/edited/removed
// from a bus, or on-demand. type: 'pickup' | 'drop' | omitted (generates both).
router.post('/:busId/generate', async (req, res) => {
  const { busId } = req.params;
  const { type } = req.body || {};
  const types = type ? [type] : ['pickup', 'drop'];

  if (!types.every((t) => ['pickup', 'drop'].includes(t))) {
    return res.status(400).json({ error: "type must be 'pickup' or 'drop'" });
  }

  try {
    const results = [];
    for (const routeType of types) {
      results.push(await generateRouteForBus(busId, routeType));
    }
    invalidateBusCache(busId); // next GPS ping picks up the new stops
    res.json({ ok: true, results });
  } catch (err) {
    console.error(`[API] Route generation failed for bus ${busId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
