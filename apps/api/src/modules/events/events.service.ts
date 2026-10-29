import { eq, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { events, ticketTypes } from '../../db/schema.js';

export async function listEvents() {
  return db.select().from(events).orderBy(asc(events.startsAt));
}

export async function getEventById(eventId: string) {
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    return null;
  }

  const types = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId))
    .orderBy(asc(ticketTypes.priceCents));

  return {
    ...event,
    ticketTypes: types.map((type) => ({
      ...type,
      availableQuantity:
        type.capacity - type.reservedQuantity - type.soldQuantity,
    })),
  };
}