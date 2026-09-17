import PgBoss from 'pg-boss';

let boss;

export async function getQueue() {
  if (boss) return boss;

  boss = new PgBoss(process.env.DATABASE_URL);
  boss.on('error', (err) => console.error('[pg-boss] error:', err.message));

  await boss.start();
  console.log('[pg-boss] queue started');
  return boss;
}

// Job names used across the backend — keep them here so producers/consumers agree.
export const JOBS = {
  EVALUATE_TRIP_STATE: 'evaluate-trip-state',
  DISPATCH_NOTIFICATION: 'dispatch-notification',
};
