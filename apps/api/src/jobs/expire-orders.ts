import { pool } from '../db/client.js';
import { processExpirationBacklog } from './expiration-cleanup.js';

async function run() {
  try {
    const { expiredCount, stopReason } = await processExpirationBacklog();
    console.log(`Expired ${expiredCount} orders`);
    if (stopReason === 'batch-limit') {
      console.log('Cleanup batch limit reached; run orders:expire again to continue processing.');
    }
  } finally {
    await pool.end();
  }
}

run()
  .catch((error) => {
    console.error('Order cleanup failed:', error);
    process.exitCode = 1;
  });
