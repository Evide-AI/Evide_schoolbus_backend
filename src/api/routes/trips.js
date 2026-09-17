import express from 'express';
import { setTripState, getTripState } from '../../workers/tripStateWorker.js';

const router = express.Router();

// Manual override — always wins immediately over the auto-detection.
// Called by the Driver/Conductor app when someone taps "Start Trip" / "End Trip".
router.post('/:busId/toggle', async (req, res) => {
  const { busId } = req.params;
  const { action, triggeredBy } = req.body; // action: 'start' | 'end', triggeredBy: 'driver' | 'conductor'

  if (!['start', 'end'].includes(action)) {
    return res.status(400).json({ error: "action must be 'start' or 'end'" });
  }

  try {
    await setTripState(busId, action === 'start' ? 'IN_PROGRESS' : 'COMPLETED', triggeredBy || 'unknown');
    res.json({ ok: true });
  } catch (err) {
    console.error('[API] trip toggle failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/:busId', async (req, res) => {
  const state = await getTripState(req.params.busId);
  res.json(state);
});

export default router;
