import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders, orderItems, ticketTypes } from '../../db/schema.js';

export async function expireOrder(orderId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);

    if (!order || order.status !== 'PENDING') {
      return false;
    }

    const result = await tx.execute<{ expired: boolean }>(
      sql`SELECT ${order.expiresAt} <= now() AS expired`,
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