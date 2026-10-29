import { and, eq, lte, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { orders } from '../db/schema.js';
import { expireOrder } from '../modules/orders/orders.expiration.js';

async function run() {
  let expiredCount = 0;

  while (true) {
    const expiredOrders = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.status, 'PENDING'),
          lte(orders.expiresAt, sql`now()`),
        ),
      )
      .limit(100);

    if (expiredOrders.length === 0) {
      break;
    }

    for (const order of expiredOrders) {
      if (await expireOrder(order.id)) {
        expiredCount++;
      }
    }

    // Avoid an infinite loop if another process is handling
    // the selected orders but has not committed yet.
    if (expiredOrders.length < 100) {
      break;
    }
  }

  console.log(`Expired ${expiredCount} orders`);
}

run()
  .catch((error) => {
    console.error('Order cleanup failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });