import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, pool } from '../../db/client.js';
import {
  events,
  ticketTypes,
  orders,
  tickets,
} from '../../db/schema.js';
import {
  createOrder,
  confirmOrder,
  OrderError,
} from './orders.service.js';
import { expireOrder } from './orders.expiration.js';


async function createTestEvent(
capacities: number[],
	) {
	const [event] = await db
		.insert(events)
		.values({
			title: 'Integration Test Event',
			description: 'Automated integration testing.',
			location: 'Test Location',
			startsAt: new Date('2027-06-01T10:00:00Z'),
		})
		.returning();

	const types = await db
		.insert(ticketTypes)
		.values(
		capacities.map((capacity, index) => ({
			eventId: event.id,
			name: `Ticket Type ${index + 1}`,
			priceCents: (index + 1) * 1000,
			capacity,
		})),
		)
		.returning();

	return { event, types };
}  

describe('Order reservations', () => {
	it('rolls back all reservations if one ticket type is unavailable', async () => {
		const { event, types } = await createTestEvent([10, 1]);

		const request = {
			eventId: event.id,
			items: [
				{ ticketTypeId: types[0].id, quantity: 2 },
				{ ticketTypeId: types[1].id, quantity: 3 },
			],
		};

		await expect(createOrder(request)).rejects.toMatchObject({
			statusCode: 409,
		});

		const inventory = await db
			.select()
			.from(ticketTypes)
			.where(eq(ticketTypes.eventId, event.id));

		for (const type of inventory) {
			expect(type.reservedQuantity).toBe(0);
			expect(type.soldQuantity).toBe(0);
		}

		const createdOrders = await db
			.select()
			.from(orders)
			.where(eq(orders.eventId, event.id));

		expect(createdOrders).toHaveLength(0);
	});

  afterAll(async () => {
    await pool.end();
  });

  it('prevents overselling under concurrent reservations', async () => {
    // Create an isolated event for this test.
    const [event] = await db
      .insert(events)
      .values({
        title: 'Concurrency Test Event',
        description: 'Testing concurrent ticket reservations.',
        location: 'Test Location',
        startsAt: new Date('2027-06-01T10:00:00Z'),
      })
      .returning();

    // Only one ticket is available.
    const [ticketType] = await db
      .insert(ticketTypes)
      .values({
        eventId: event.id,
        name: 'General Admission',
        priceCents: 5000,
        capacity: 1,
      })
      .returning();

    const request = {
      eventId: event.id,
      items: [
        {
          ticketTypeId: ticketType.id,
          quantity: 1,
        },
      ],
    };

    // Both requests attempt to reserve the same last ticket.
    const results = await Promise.allSettled([
      createOrder(request),
      createOrder(request),
    ]);

    const successful = results.filter(
      (result) => result.status === 'fulfilled',
    );

    const failed = results.filter(
      (result) => result.status === 'rejected',
    );

    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const rejection = failed[0];

    if (rejection.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(OrderError);
      expect(rejection.reason.statusCode).toBe(409);
    }

    // Verify the actual database state.
    const [inventory] = await db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticketType.id));

    expect(inventory.reservedQuantity).toBe(1);
    expect(inventory.soldQuantity).toBe(0);

    const createdOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.eventId, event.id));

    expect(createdOrders).toHaveLength(1);
    expect(createdOrders[0].status).toBe('PENDING');
  });

	
	it('does not issue duplicate tickets when an order is confirmed twice', async () => {
		const { event, types } = await createTestEvent([10]);

		const order = await createOrder({
			eventId: event.id,
			items: [
				{ ticketTypeId: types[0].id, quantity: 2 },
			],
		});

		const firstConfirmation = await confirmOrder(order.id);
		const secondConfirmation = await confirmOrder(order.id);

		expect(firstConfirmation.status).toBe('CONFIRMED');
		expect(secondConfirmation.status).toBe('CONFIRMED');

		const issuedTickets = await db
			.select()
			.from(tickets)
			.where(eq(tickets.orderId, order.id));

		expect(issuedTickets).toHaveLength(2);

		const [inventory] = await db
			.select()
			.from(ticketTypes)
			.where(eq(ticketTypes.id, types[0].id));

		expect(inventory.reservedQuantity).toBe(0);
		expect(inventory.soldQuantity).toBe(2);
	});
	
	it('keeps inventory consistent when confirmation and expiration run concurrently', async () => {
		const { event, types } = await createTestEvent([5]);

		const order = await createOrder({
			eventId: event.id,
			items: [
				{ ticketTypeId: types[0].id, quantity: 2 },
			],
		});

		const results = await Promise.allSettled([
			confirmOrder(order.id),
			expireOrder(order.id),
		]);

		expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

		const [storedOrder] = await db
			.select()
			.from(orders)
			.where(eq(orders.id, order.id));

		const [inventory] = await db
			.select()
			.from(ticketTypes)
			.where(eq(ticketTypes.id, types[0].id));

		const issuedTickets = await db
			.select()
			.from(tickets)
			.where(eq(tickets.orderId, order.id));

		expect(storedOrder.status).toBe('CONFIRMED');
		expect(inventory.reservedQuantity).toBe(0);
		expect(inventory.soldQuantity).toBe(2);
		expect(issuedTickets).toHaveLength(2);
	});

});
