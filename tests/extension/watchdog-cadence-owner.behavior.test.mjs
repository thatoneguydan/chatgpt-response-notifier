import test from 'node:test';


test('watchdog cadence owner blocks stale, duplicate, uncertain, and replay sends', async () => {
  await import('../../tools/reproduce-watchdog-cadence-20260926.mjs');
});
