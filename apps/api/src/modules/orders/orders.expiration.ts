import { and, eq, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders, orderItems, ticketTypes } from '../../db/schema.js';

export async function expireOrder(orderId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Share the order lock with confirmation so inventory is released only once.
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);

    if (!order || order.status !== 'PENDING') {
      return false;
    }

    // Use current database time: now() stays fixed while waiting for the lock.
    const result = await tx.execute<{ expired: boolean }>(
      sql`SELECT ${order.expiresAt} <= clock_timestamp() AS expired`,
    );

    if (!result.rows[0].expired) {
      return false;
    }

    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    for (const item of items) {
      await tx
        .update(ticketTypes)
        .set({
          reservedQuantity: sql`${ticketTypes.reservedQuantity} - ${item.quantity}`,
        })
        .where(eq(ticketTypes.id, item.ticketTypeId));
    }

    await tx
      .update(orders)
      .set({ status: 'EXPIRED' })
      .where(eq(orders.id, orderId));

    return true;
  });
}

export async function expirePendingOrders(
  limit = 100,
): Promise<number> {
  const expiredOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'PENDING'),
        lte(orders.expiresAt, sql`now()`),
      ),
    )
    .limit(limit);

  let expiredCount = 0;

  for (const order of expiredOrders) {
    const expired = await expireOrder(order.id);

    if (expired) {
      expiredCount++;
    }
  }

  return expiredCount;
}
