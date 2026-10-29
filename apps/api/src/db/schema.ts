import {
    pgTable,
    pgEnum,
    uuid,
    varchar,
    text,
    integer,
    timestamp,
    uniqueIndex,
    index,
    check,
  } from 'drizzle-orm/pg-core';
  import { sql } from 'drizzle-orm';
  
  export const orderStatus = pgEnum('order_status', [
    'PENDING',
    'CONFIRMED',
    'EXPIRED',
    'CANCELLED',
  ]);
  
  export const events = pgTable('events', {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description').notNull(),
    location: varchar('location', { length: 255 }).notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  });
  
  export const ticketTypes = pgTable(
    'ticket_types',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      eventId: uuid('event_id')
        .notNull()
        .references(() => events.id),
      name: varchar('name', { length: 100 }).notNull(),
      priceCents: integer('price_cents').notNull(),
      capacity: integer('capacity').notNull(),
      reservedQuantity: integer('reserved_quantity').notNull().default(0),
      soldQuantity: integer('sold_quantity').notNull().default(0),
    },
    (table) => [
      index('ticket_types_event_id_idx').on(table.eventId),
      check('ticket_types_price_nonnegative', sql`${table.priceCents} >= 0`),
      check(
        'ticket_types_inventory_valid',
        sql`${table.capacity} >= 0
            AND ${table.reservedQuantity} >= 0
            AND ${table.soldQuantity} >= 0
            AND ${table.reservedQuantity} + ${table.soldQuantity} <= ${table.capacity}`,
      ),
    ],
  );
  
  export const orders = pgTable(
    'orders',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      eventId: uuid('event_id')
        .notNull()
        .references(() => events.id),
      status: orderStatus('status').notNull().default('PENDING'),
      totalCents: integer('total_cents').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    },
    (table) => [
      index('orders_event_id_idx').on(table.eventId),
      index('orders_status_expires_at_idx').on(table.status, table.expiresAt),
      check('orders_total_nonnegative', sql`${table.totalCents} >= 0`),
    ],
  );
  
  export const orderItems = pgTable(
    'order_items',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      orderId: uuid('order_id')
        .notNull()
        .references(() => orders.id),
      ticketTypeId: uuid('ticket_type_id')
        .notNull()
        .references(() => ticketTypes.id),
      quantity: integer('quantity').notNull(),
      unitPriceCents: integer('unit_price_cents').notNull(),
    },
    (table) => [
      uniqueIndex('order_items_order_ticket_type_unique').on(
        table.orderId,
        table.ticketTypeId,
      ),
      check('order_items_quantity_positive', sql`${table.quantity} > 0`),
      check('order_items_price_nonnegative', sql`${table.unitPriceCents} >= 0`),
    ],
  );
  
  export const tickets = pgTable(
    'tickets',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      orderId: uuid('order_id')
        .notNull()
        .references(() => orders.id),
      ticketTypeId: uuid('ticket_type_id')
        .notNull()
        .references(() => ticketTypes.id),
      purchasePriceCents: integer('purchase_price_cents').notNull(),
      issuedAt: timestamp('issued_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      index('tickets_order_id_idx').on(table.orderId),
      check(
        'tickets_purchase_price_nonnegative',
        sql`${table.purchasePriceCents} >= 0`,
      ),
    ],
  );