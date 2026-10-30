import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
    events,
    orders,
    orderItems,
    ticketTypes,
    tickets,
  } from '../../db/schema.js';

const RESERVATION_MINUTES = 10;

export type CreateOrderInput = {
  visitorId: string;
  idempotencyKey: string;
  eventId: string;
  items: {
    ticketTypeId: string;
    quantity: number;
  }[];
};

export async function listOrdersByVisitor(visitorId: string) {
  return db
    .select({
      id: orders.id,
      eventId: orders.eventId,
      status: orders.status,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      expiresAt: orders.expiresAt,
      confirmedAt: orders.confirmedAt,
    })
    .from(orders)
    .where(eq(orders.visitorId, visitorId))
    .orderBy(desc(orders.createdAt));
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
  // Reserve ticket types in the same order to reduce deadlocks.
  const items = [...input.items].sort((a, b) =>
    a.ticketTypeId.localeCompare(b.ticketTypeId),
  );

  if (new Set(items.map((item) => item.ticketTypeId)).size !== items.length) {
    throw new OrderError('Duplicate ticket types are not allowed', 400);
  }

  return db.transaction(async (tx) => {
    // Serialize retries across API instances before checking for an existing order.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${input.visitorId} || ':' || ${input.idempotencyKey},
          0
        )
      )
    `);

    const [existingOrder] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.visitorId, input.visitorId),
          eq(orders.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingOrder) {
      const existingItems = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, existingOrder.id));

      const sameRequest =
        existingOrder.eventId === input.eventId &&
        existingItems.length === items.length &&
        items.every((item) =>
          existingItems.some(
            (stored) =>
              stored.ticketTypeId === item.ticketTypeId &&
              stored.quantity === item.quantity,
          ),
        );

      if (!sameRequest) {
        throw new OrderError(
          'Idempotency key was already used with different order data',
          409,
        );
      }

      return {
        id: existingOrder.id,
        visitorId: existingOrder.visitorId,
        idempotencyKey: existingOrder.idempotencyKey,
        status: existingOrder.status,
        totalCents: existingOrder.totalCents,
        expiresAt: existingOrder.expiresAt,
        items: existingItems.map((item) => ({
          ticketTypeId: item.ticketTypeId,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
        })),
      };
    }

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
      // Reserve only if enough tickets remain. PostgreSQL rechecks this condition
      // after waiting for another transaction to update the same inventory row.
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

    // Start the deadline from the database transaction time.
    const [createdOrder] = await tx
      .insert(orders)
      .values({
        eventId: input.eventId,
        visitorId: input.visitorId,
        idempotencyKey: input.idempotencyKey,
        status: 'PENDING',
        totalCents,
        expiresAt: sql`now() + interval '10 minutes'`,
      })
      .returning({
        id: orders.id,
        visitorId: orders.visitorId,
        idempotencyKey: orders.idempotencyKey,
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

export async function confirmOrder(orderId: string) {
    const result = await db.transaction(async (tx) => {
      // Confirmation and expiration share this lock to protect inventory and tickets.
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update')
        .limit(1);
  
      if (!order) {
        return { outcome: 'NOT_FOUND' as const };
      }
  
      if (order.status === 'CONFIRMED') {
        return {
          outcome: 'CONFIRMED' as const,
          order,
        };
      }
  
      if (order.status !== 'PENDING') {
        return {
          outcome: 'INVALID_STATUS' as const,
          status: order.status,
        };
      }
  
      const items = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
  
      // Use current database time: now() stays fixed while waiting for the lock.
      const result = await tx.execute<{ expired: boolean }>(
        sql`SELECT ${order.expiresAt} <= clock_timestamp() AS expired`,
      );
      
      const expired = result.rows[0].expired;
  
      if (expired) {
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
          .where(eq(orders.id, order.id));
  
        // Commit the inventory release before reporting the error outside the transaction.
        return { outcome: 'EXPIRED' as const };
      }
  
      for (const item of items) {
        await tx
          .update(ticketTypes)
          .set({
            reservedQuantity: sql`${ticketTypes.reservedQuantity} - ${item.quantity}`,
            soldQuantity: sql`${ticketTypes.soldQuantity} + ${item.quantity}`,
          })
          .where(eq(ticketTypes.id, item.ticketTypeId));
      }
  
      const ticketRows = items.flatMap((item) =>
        Array.from({ length: item.quantity }, () => ({
          orderId: order.id,
          ticketTypeId: item.ticketTypeId,
          purchasePriceCents: item.unitPriceCents,
        })),
      );
  
      const issuedTickets = await tx
        .insert(tickets)
        .values(ticketRows)
        .returning();
  
      const [confirmedOrder] = await tx
        .update(orders)
        .set({
          status: 'CONFIRMED',
          confirmedAt: sql`now()`,
        })
        .where(eq(orders.id, order.id))
        .returning();
  
      return {
        outcome: 'CONFIRMED' as const,
        order: confirmedOrder,
        tickets: issuedTickets,
      };
    });
  
    if (result.outcome === 'NOT_FOUND') {
      throw new OrderError('Order not found', 404);
    }
  
    if (result.outcome === 'EXPIRED') {
      throw new OrderError('Order has expired', 409);
    }
  
    if (result.outcome === 'INVALID_STATUS') {
      throw new OrderError(
        `Cannot confirm an order with status ${result.status}`,
        409,
      );
    }
  
    return result.order;
  }
