import { db, pool } from './client.js';
import { events, ticketTypes } from './schema.js';

const sampleEvents = [
  {
    title: 'Amsterdam Tech Conference',
    description: 'A conference about software engineering and technology.',
    location: 'Amsterdam, Netherlands',
    startsAt: new Date('2027-03-15T09:00:00Z'),
    ticketTypes: [
      { name: 'General Admission', priceCents: 4900, capacity: 150 },
      { name: 'VIP', priceCents: 12900, capacity: 30 },
    ],
  },
  {
    title: 'European Racing Weekend',
    description: 'A weekend of motorsport and entertainment.',
    location: 'Zandvoort, Netherlands',
    startsAt: new Date('2027-05-22T10:00:00Z'),
    ticketTypes: [
      { name: 'Grandstand', priceCents: 9900, capacity: 200 },
      { name: 'Paddock Experience', priceCents: 24900, capacity: 40 },
    ],
  },
];

async function seed() {
  for (const event of sampleEvents) {
    await db.transaction(async (tx) => {
      const [createdEvent] = await tx
        .insert(events)
        .values({
          title: event.title,
          description: event.description,
          location: event.location,
          startsAt: event.startsAt,
        })
        .returning({ id: events.id });

      await tx.insert(ticketTypes).values(
        event.ticketTypes.map((ticketType) => ({
          eventId: createdEvent.id,
          ...ticketType,
        })),
      );
    });
  }

  console.log('Database seeded successfully');
}

seed()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });