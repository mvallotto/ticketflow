import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

import { db, pool } from '../../db/client.js';
import { buildApp } from '../../app.js';
import { processExpirationBacklog } from '../../jobs/expiration-cleanup.js';
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
import { expireOrder, expirePendingOrders } from './orders.expiration.js';


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

async function createExpirationTestOrder() {
  const { event, types } = await createTestEvent([5]);
  const order = await createOrder({
    visitorId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    eventId: event.id,
    items: [{ ticketTypeId: types[0].id, quantity: 2 }],
  });
  return { order, ticketTypeId: types[0].id };
}

async function markOrderExpired(orderId: string) {
  await db.update(orders)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 minute'` })
    .where(eq(orders.id, orderId));
}

async function expectExpiredInventory(orderId: string, ticketTypeId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  const [inventory] = await db.select().from(ticketTypes)
    .where(eq(ticketTypes.id, ticketTypeId));
  const issuedTickets = await db.select().from(tickets)
    .where(eq(tickets.orderId, orderId));

  expect.soft(order.status).toBe('EXPIRED');
  expect.soft(order.confirmedAt).toBeNull();
  expect.soft(inventory.reservedQuantity).toBe(0);
  expect.soft(inventory.soldQuantity).toBe(0);
  expect.soft(issuedTickets).toHaveLength(0);
}

// Wait until PostgreSQL reports the blocked request before moving the deadline.
async function runAcrossExpiration<T>(orderId: string, operation: () => Promise<T>) {
  const blocker = await pool.connect();
  let completion: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    const { rows: [owner] } = await blocker.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    await blocker.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    completion = Promise.allSettled([operation()]);

    await expect.poll(async () => {
      const { rows } = await pool.query(`
        SELECT pid FROM pg_stat_activity
        WHERE $1::integer = ANY(pg_blocking_pids(pid))
          AND datname = current_database()
          AND xact_start < clock_timestamp()
      `, [owner.pid]);
      return rows.length;
    }, { timeout: 5_000 }).toBe(1);

    await blocker.query(
      'UPDATE orders SET expires_at = clock_timestamp() WHERE id = $1', [orderId],
    );
    const { rows: [clock] } = await blocker.query<{ expired: boolean }>(
      'SELECT expires_at < clock_timestamp() AS expired FROM orders WHERE id = $1',
      [orderId],
    );
    expect(clock.expired).toBe(true);
    await blocker.query('COMMIT');
    return (await completion)[0];
  } finally {
    // Release the lock even if a test assertion fails.
    try {
      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
      await completion;
    }
  }
}

describe('Order reservations', () => {
  describe('HTTP request validation', () => {
    const app = buildApp();

    beforeAll(async () => {
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it.each([
      'empty body',
      'missing items',
      'empty items',
      'zero quantity',
      'negative quantity',
      'fractional quantity',
      'quantity above maximum',
      'invalid visitor UUID',
      'invalid idempotency UUID',
      'invalid event UUID',
      'invalid ticket type UUID',
    ])('rejects %s without changing orders or inventory', async (invalidCase) => {
      const { event, types } = await createTestEvent([100]);
      const item = { ticketTypeId: types[0].id, quantity: 1 };
      const payload: Record<string, unknown> = {
        visitorId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        eventId: event.id,
        items: [item],
      };

      switch (invalidCase) {
        case 'empty body':
          for (const key of Object.keys(payload)) delete payload[key];
          break;
        case 'missing items': delete payload.items; break;
        case 'empty items': payload.items = []; break;
        case 'zero quantity': item.quantity = 0; break;
        case 'negative quantity': item.quantity = -1; break;
        case 'fractional quantity': item.quantity = 1.5; break;
        case 'quantity above maximum': item.quantity = 101; break;
        case 'invalid visitor UUID': payload.visitorId = 'not-a-uuid'; break;
        case 'invalid idempotency UUID': payload.idempotencyKey = 'not-a-uuid'; break;
        case 'invalid event UUID': payload.eventId = 'not-a-uuid'; break;
        case 'invalid ticket type UUID': item.ticketTypeId = 'not-a-uuid'; break;
        default: throw new Error(`Unhandled validation case: ${invalidCase}`);
      }

      const response = await app.inject({ method: 'POST', url: '/api/orders', payload });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        message: expect.any(String),
      });
      const storedOrders = await db.select().from(orders)
        .where(eq(orders.eventId, event.id));
      const [inventory] = await db.select().from(ticketTypes)
        .where(eq(ticketTypes.id, types[0].id));
      const issuedTickets = await db.select().from(tickets)
        .where(eq(tickets.ticketTypeId, types[0].id));

      expect(storedOrders).toHaveLength(0);
      expect(inventory).toEqual(types[0]);
      expect(issuedTickets).toHaveLength(0);
    });

    it.each([
      { method: 'GET' as const, url: '/api/orders' },
      { method: 'GET' as const, url: '/api/orders?visitorId=not-a-uuid' },
      { method: 'POST' as const, url: '/api/orders/not-a-uuid/confirm' },
    ])('rejects invalid query or path parameters: $method $url', async (request) => {
      const response = await app.inject(request);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        message: expect.any(String),
      });
    });
  });

  it('expires only eligible pending orders within the batch limit and does not release them again', async () => {
    // Process expired fixtures from earlier runs before checking exact counts.
    let backlogDrained = false;
    for (let batch = 0; batch < 20; batch++) {
      if (await expirePendingOrders() === 0) {
        backlogDrained = true;
        break;
      }
    }
    expect(backlogDrained).toBe(true);

    const eligible = [];
    for (let index = 0; index < 3; index++) {
      const fixture = await createExpirationTestOrder();
      await markOrderExpired(fixture.order.id);
      eligible.push(fixture);
    }

    const future = await createExpirationTestOrder();
    await db.update(orders)
      .set({ expiresAt: sql`clock_timestamp() + interval '1 day'` })
      .where(eq(orders.id, future.order.id));
    const confirmed = await createExpirationTestOrder();
    await confirmOrder(confirmed.order.id);
    await markOrderExpired(confirmed.order.id);
    const alreadyExpired = await createExpirationTestOrder();
    await markOrderExpired(alreadyExpired.order.id);
    expect(await expireOrder(alreadyExpired.order.id)).toBe(true);

    const excluded = [future, confirmed, alreadyExpired];
    const excludedOrderIds = excluded.map(({ order }) => order.id);
    const excludedTypeIds = excluded.map(({ ticketTypeId }) => ticketTypeId);
    async function snapshotExcluded() {
      return {
        orders: await db.select().from(orders)
          .where(inArray(orders.id, excludedOrderIds)).orderBy(orders.id),
        inventory: await db.select().from(ticketTypes)
          .where(inArray(ticketTypes.id, excludedTypeIds)).orderBy(ticketTypes.id),
        tickets: await db.select().from(tickets)
          .where(inArray(tickets.orderId, excludedOrderIds)).orderBy(tickets.id),
      };
    }
    const beforeExcluded = await snapshotExcluded();

    expect(await expirePendingOrders(2)).toBe(2);
    const firstBatch = await db.select().from(orders)
      .where(inArray(orders.id, eligible.map(({ order }) => order.id)));
    // Batches have no fixed row order; check counts instead of selected IDs.
    expect(firstBatch.filter((order) => order.status === 'EXPIRED')).toHaveLength(2);
    expect(firstBatch.filter((order) => order.status === 'PENDING')).toHaveLength(1);
    for (const fixture of eligible) {
      const storedOrder = firstBatch.find((order) => order.id === fixture.order.id)!;
      const [inventory] = await db.select().from(ticketTypes)
        .where(eq(ticketTypes.id, fixture.ticketTypeId));
      expect(inventory.reservedQuantity).toBe(storedOrder.status === 'EXPIRED' ? 0 : 2);
      expect(inventory.soldQuantity).toBe(0);
    }
    expect(await snapshotExcluded()).toEqual(beforeExcluded);

    expect(await expirePendingOrders(2)).toBe(1);
    expect(await expirePendingOrders(2)).toBe(0);
    for (const { order, ticketTypeId } of eligible) {
      await expectExpiredInventory(order.id, ticketTypeId);
    }
    expect(await snapshotExcluded()).toEqual(beforeExcluded);
  }, 15_000);

  it('processes a database backlog across bounded cycles without releasing inventory twice', async () => {
    const preparation = await processExpirationBacklog({ maxBatches: 100 });
    expect(preparation.stopReason).toBe('no-progress');
    const eligible = [];
    for (let index = 0; index < 5; index++) {
      const fixture = await createExpirationTestOrder();
      await markOrderExpired(fixture.order.id);
      eligible.push(fixture);
    }

    expect(await processExpirationBacklog({ batchSize: 2, maxBatches: 2 })).toEqual({
      expiredCount: 4, batchesProcessed: 2, stopReason: 'batch-limit',
    });
    const firstCycle = await db.select().from(orders)
      .where(inArray(orders.id, eligible.map(({ order }) => order.id)));
    expect(firstCycle.filter((order) => order.status === 'EXPIRED')).toHaveLength(4);
    expect(firstCycle.filter((order) => order.status === 'PENDING')).toHaveLength(1);
    for (const fixture of eligible) {
      const stored = firstCycle.find((order) => order.id === fixture.order.id)!;
      const [inventory] = await db.select().from(ticketTypes)
        .where(eq(ticketTypes.id, fixture.ticketTypeId));
      expect(inventory.reservedQuantity).toBe(stored.status === 'EXPIRED' ? 0 : 2);
      expect(inventory.soldQuantity).toBe(0);
    }

    expect(await processExpirationBacklog({ batchSize: 2, maxBatches: 2 })).toEqual({
      expiredCount: 1, batchesProcessed: 2, stopReason: 'no-progress',
    });
    expect((await processExpirationBacklog()).expiredCount).toBe(0);
    for (const { order, ticketTypeId } of eligible) {
      await expectExpiredInventory(order.id, ticketTypeId);
    }
  }, 15_000);

  it('leaves an unexpired order and its inventory unchanged', async () => {
    const { order, ticketTypeId } = await createExpirationTestOrder();
    await db.update(orders)
      .set({ expiresAt: sql`clock_timestamp() + interval '1 hour'` })
      .where(eq(orders.id, order.id));

    const [beforeOrder] = await db.select().from(orders).where(eq(orders.id, order.id));
    const [beforeInventory] = await db.select().from(ticketTypes)
      .where(eq(ticketTypes.id, ticketTypeId));

    expect(await expireOrder(order.id)).toBe(false);

    const [afterOrder] = await db.select().from(orders).where(eq(orders.id, order.id));
    const [afterInventory] = await db.select().from(ticketTypes)
      .where(eq(ticketTypes.id, ticketTypeId));
    const issuedTickets = await db.select().from(tickets)
      .where(eq(tickets.orderId, order.id));

    expect(afterOrder).toEqual(beforeOrder);
    expect(afterOrder.status).toBe('PENDING');
    expect(afterInventory).toEqual(beforeInventory);
    expect(afterInventory.reservedQuantity).toBe(2);
    expect(afterInventory.soldQuantity).toBe(0);
    expect(issuedTickets).toHaveLength(0);
  });

  it('issues tickets only once when two confirmations contend for the order lock', async () => {
    const { order, ticketTypeId } = await createExpirationTestOrder();
    const blocker = await pool.connect();
    let confirmations: Promise<PromiseSettledResult<Awaited<ReturnType<typeof confirmOrder>>>[]> | undefined;

    try {
      await blocker.query('BEGIN');
      const { rows: [owner] } = await blocker.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      await blocker.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
      confirmations = Promise.allSettled([confirmOrder(order.id), confirmOrder(order.id)]);

      // The second request may wait behind the first, rather than directly on our lock.
      await expect.poll(async () => {
        const { rows } = await pool.query(`
          WITH RECURSIVE waiters(pid) AS (
            SELECT $1::integer
            UNION
            SELECT activity.pid FROM pg_stat_activity AS activity
            JOIN waiters ON waiters.pid = ANY(pg_blocking_pids(activity.pid))
            WHERE activity.datname = current_database()
          )
          SELECT pid FROM waiters WHERE pid <> $1::integer
        `, [owner.pid]);
        return rows.length;
      }, { timeout: 3_000 }).toBe(2);

      await blocker.query('COMMIT');
      const results = await confirmations;
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value.id).toBe(order.id);
          expect(result.value.status).toBe('CONFIRMED');
        }
      }
      if (results[0].status === 'fulfilled' && results[1].status === 'fulfilled') {
        expect(results[0].value.confirmedAt).toEqual(results[1].value.confirmedAt);
      }
    } finally {
      try {
        await blocker.query('ROLLBACK');
      } finally {
        blocker.release();
        await confirmations;
      }
    }

    const [storedOrder] = await db.select().from(orders).where(eq(orders.id, order.id));
    const [inventory] = await db.select().from(ticketTypes)
      .where(eq(ticketTypes.id, ticketTypeId));
    const issuedTickets = await db.select().from(tickets)
      .where(eq(tickets.orderId, order.id));

    expect(storedOrder.status).toBe('CONFIRMED');
    expect(storedOrder.confirmedAt).not.toBeNull();
    expect(inventory.reservedQuantity).toBe(0);
    expect(inventory.soldQuantity).toBe(2);
    expect(issuedTickets).toHaveLength(2);
    for (const ticket of issuedTickets) {
      expect(ticket.ticketTypeId).toBe(ticketTypeId);
      expect(ticket.purchasePriceCents).toBe(1000);
    }
  });

  it('rejects confirmation of an expired order and commits the inventory release without tickets', async () => {
    const { order, ticketTypeId } = await createExpirationTestOrder();
    await markOrderExpired(order.id);

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Order has expired',
    });
    await expectExpiredInventory(order.id, ticketTypeId);
    expect(await expireOrder(order.id)).toBe(false);
    await expect(confirmOrder(order.id)).rejects.toMatchObject({ statusCode: 409 });
    await expectExpiredInventory(order.id, ticketTypeId);
  });

  it('releases inventory exactly once for concurrent and repeated expiration attempts', async () => {
    const { order, ticketTypeId } = await createExpirationTestOrder();
    await markOrderExpired(order.id);

    const results = await Promise.all([expireOrder(order.id), expireOrder(order.id)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await expireOrder(order.id)).toBe(false);
    await expectExpiredInventory(order.id, ticketTypeId);
  });

  it.each(['confirmation first', 'expiration first'] as const)(
    'never issues tickets when confirmation races expiration on an expired order: %s',
    async (startOrder) => {
      const { order, ticketTypeId } = await createExpirationTestOrder();
      await markOrderExpired(order.id);

      const confirmation = () => confirmOrder(order.id);
      const expiration = () => expireOrder(order.id);
      const operations = startOrder === 'confirmation first'
        ? [confirmation, expiration] : [expiration, confirmation];
      const results = await Promise.allSettled(operations.map((operation) => operation()));
      const confirmationResult = results[startOrder === 'confirmation first' ? 0 : 1];
      const expirationResult = results[startOrder === 'confirmation first' ? 1 : 0];

      expect(confirmationResult.status).toBe('rejected');
      if (confirmationResult.status === 'rejected') {
        expect(confirmationResult.reason).toBeInstanceOf(OrderError);
        expect(confirmationResult.reason.statusCode).toBe(409);
      }
      expect(expirationResult.status).toBe('fulfilled');
      expect(await expireOrder(order.id)).toBe(false);
      await expectExpiredInventory(order.id, ticketTypeId);
    },
  );

  it('rejects confirmation when the deadline passes while waiting for the order lock', async () => {
    const { order, ticketTypeId } = await createExpirationTestOrder();
    const result = await runAcrossExpiration(order.id, () => confirmOrder(order.id));

    await expectExpiredInventory(order.id, ticketTypeId);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toMatchObject({ statusCode: 409 });
    }
  });

  it('expires an order when the deadline passes while waiting for the order lock', async () => {
    const { order, ticketTypeId } = await createExpirationTestOrder();
    const result = await runAcrossExpiration(order.id, () => expireOrder(order.id));

    await expectExpiredInventory(order.id, ticketTypeId);
    expect(result).toEqual({ status: 'fulfilled', value: true });
  });

	it('rolls back all reservations if one ticket type is unavailable', async () => {
		const { event, types } = await createTestEvent([10, 10]);
    // Make the first reservation succeed so the second failure must roll it back.
    const [availableType, unavailableType] = [...types].sort((a, b) =>
      a.id.localeCompare(b.id),
    );

		const request = {
			visitorId: crypto.randomUUID(),
			idempotencyKey: crypto.randomUUID(),
			eventId: event.id,
			items: [
				{ ticketTypeId: availableType.id, quantity: 2 },
				{ ticketTypeId: unavailableType.id, quantity: 11 },
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
    const [event] = await db
      .insert(events)
      .values({
        title: 'Concurrency Test Event',
        description: 'Testing concurrent ticket reservations.',
        location: 'Test Location',
        startsAt: new Date('2027-06-01T10:00:00Z'),
      })
      .returning();

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

    const results = await Promise.allSettled([
			createOrder({
				...request,
				visitorId: crypto.randomUUID(),
				idempotencyKey: crypto.randomUUID(),
			}),
			createOrder({
				...request,
				visitorId: crypto.randomUUID(),
				idempotencyKey: crypto.randomUUID(),
			}),
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
			visitorId: crypto.randomUUID(),
			idempotencyKey: crypto.randomUUID(),
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
			visitorId: crypto.randomUUID(),
			idempotencyKey: crypto.randomUUID(),
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
	
	it('creates only one order for concurrent requests with the same idempotency key', async () => {
		const { event, types } = await createTestEvent([10]);

		const request = {
			visitorId: crypto.randomUUID(),
			idempotencyKey: crypto.randomUUID(),
			eventId: event.id,
			items: [
				{ ticketTypeId: types[0].id, quantity: 2 },
			],
		};

		const [first, second] = await Promise.all([
			createOrder(request),
			createOrder(request),
		]);

		expect(first.id).toBe(second.id);

		const storedOrders = await db
			.select()
			.from(orders)
			.where(eq(orders.eventId, event.id));

		expect(storedOrders).toHaveLength(1);

		const [inventory] = await db
			.select()
			.from(ticketTypes)
			.where(eq(ticketTypes.id, types[0].id));

		expect(inventory.reservedQuantity).toBe(2);
		expect(inventory.soldQuantity).toBe(0);
	});
		
	it('rejects reusing an idempotency key with different order data', async () => {
		const { event, types } = await createTestEvent([10]);

		const request = {
			visitorId: crypto.randomUUID(),
			idempotencyKey: crypto.randomUUID(),
			eventId: event.id,
			items: [
				{ ticketTypeId: types[0].id, quantity: 1 },
			],
		};

		await createOrder(request);

		await expect(
			createOrder({
				...request,
				items: [
					{ ticketTypeId: types[0].id, quantity: 3 },
				],
			}),
		).rejects.toMatchObject({
			statusCode: 409,
		});

		const [inventory] = await db
			.select()
			.from(ticketTypes)
			.where(eq(ticketTypes.id, types[0].id));

		expect(inventory.reservedQuantity).toBe(1);
	});

});
