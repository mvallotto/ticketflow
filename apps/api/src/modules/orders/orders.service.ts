
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { events, orders, orderItems, ticketTypes } from '../../db/schema.js';

const RESERVATION_MINUTES = 10;

export interface CreateOrderInput {
  eventId: string;
  items: {
    ticketTypeId: string;
    quantity: number;
  }[];
}

export class OrderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'OrderError';
  }
}

export async function createOrder(input: CreateOrderInput) {
  // A deterministic order reduces the risk of deadlocks when
  // concurrent requests reserve multiple ticket types.
  const items = [...input.items].sort((a, b) =>
    a.ticketTypeId.localeCompare(b.ticketTypeId),
  );

  if (new Set(items.map((item) => item.ticketTypeId)).size !== items.length) {
    throw new OrderError('Duplicate ticket types are not allowed', 400);
  }

  return db.transaction(async (tx) => {
    const [event] = await tx
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, input.eventId))
      .limit(1);

    if (!event) {
      throw new OrderError('Event not found', 404);
    }

    let totalCents = 0;

    const reservedItems: {
      ticketTypeId: string;
      quantity: number;
      unitPriceCents: number;
    }[] = [];

    for (const item of items) {
      // Atomically reserve inventory only if enough tickets remain.
      // PostgreSQL rechecks the condition after waiting for a
      // concurrent transaction updating the same row.
      const [reserved] = await tx
        .update(ticketTypes)
        .set({
          reservedQuantity: sql`${ticketTypes.reservedQuantity} + ${item.quantity}`,
        })
        .where(
          and(
            eq(ticketTypes.id, item.ticketTypeId),
            eq(ticketTypes.eventId, input.eventId),
            gte(
              sql<number>`${ticketTypes.capacity} - ${ticketTypes.reservedQuantity} - ${ticketTypes.soldQuantity}`,
              item.quantity,
            ),
          ),
        )
        .returning({
          id: ticketTypes.id,
          priceCents: ticketTypes.priceCents,
        });

      if (!reserved) {
        throw new OrderError(
          'Ticket type not found or insufficient availability',
          409,
        );
      }

      totalCents += reserved.priceCents * item.quantity;

      reservedItems.push({
        ticketTypeId: reserved.id,
        quantity: item.quantity,
        unitPriceCents: reserved.priceCents,
      });
    }

    // Use the database clock for the reservation expiry.
    const [createdOrder] = await tx
      .insert(orders)
      .values({
        eventId: input.eventId,
        status: 'PENDING',
        totalCents,
        expiresAt: sql`now() + interval '10 minutes'`,
      })
      .returning({
        id: orders.id,
        status: orders.status,
        totalCents: orders.totalCents,
        expiresAt: orders.expiresAt,
      });

    await tx.insert(orderItems).values(
      reservedItems.map((item) => ({
        orderId: createdOrder.id,
        ...item,
      })),
    );

    return {
      ...createdOrder,
      items: reservedItems,
    };
  });
}
