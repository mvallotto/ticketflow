import { db, pool } from './client.js';
import { events, ticketTypes } from './schema.js';

// Dates, prices and capacities are demo values, not official event information.
const sampleEvents = [
  {
    title: 'F1 GP Bahrain',
    description: 'A demo Formula 1 event in Bahrain with VIP, Prestige and Standard tickets.',
    location: 'Bahrain',
    startsAt: new Date('2027-03-21T15:00:00Z'),
    ticketTypes: [
      { name: 'Ticket VIP', priceCents: 60000, capacity: 20 },
      { name: 'Ticket Prestige', priceCents: 35000, capacity: 50 },
      { name: 'Ticket Standard', priceCents: 15000, capacity: 150 },
    ],
  },
  {
    title: 'F1 GP Malaysia',
    description: 'A demo Formula 1 event in Malaysia with VIP, Prestige and Standard tickets.',
    location: 'Malaysia',
    startsAt: new Date('2027-04-11T07:00:00Z'),
    ticketTypes: [
      { name: 'Ticket VIP', priceCents: 50000, capacity: 20 },
      { name: 'Ticket Prestige', priceCents: 25000, capacity: 50 },
      { name: 'Ticket Standard', priceCents: 10000, capacity: 150 },
    ],
  },
  {
    title: 'F1 GP Monza',
    description: 'A demo Formula 1 event in Monza with VIP, Prestige and Standard tickets.',
    location: 'Monza, Italy',
    startsAt: new Date('2027-09-05T13:00:00Z'),
    ticketTypes: [
      { name: 'Ticket VIP', priceCents: 90000, capacity: 20 },
      { name: 'Ticket Prestige', priceCents: 50000, capacity: 50 },
      { name: 'Ticket Standard', priceCents: 20000, capacity: 150 },
    ],
  },
  {
    title: 'MotoGP GP Mugello',
    description: 'A demo MotoGP event in Mugello with VIP, Roof and Grass tickets.',
    location: 'Mugello, Italy',
    startsAt: new Date('2027-06-06T12:00:00Z'),
    ticketTypes: [
      { name: 'Ticket VIP', priceCents: 40000, capacity: 20 },
      { name: 'Ticket Roof', priceCents: 18000, capacity: 80 },
      { name: 'Ticket Grass', priceCents: 8000, capacity: 200 },
    ],
  },
  {
    title: 'UEFA Champions League Semi-Final Berlin',
    description: 'A demo football semi-final in Berlin with central, home and visitor ticket areas.',
    location: 'Berlin, Germany',
    startsAt: new Date('2027-05-05T19:00:00Z'),
    ticketTypes: [
      { name: 'Ticket Central Area A', priceCents: 30000, capacity: 60 },
      { name: 'Ticket Central Area B', priceCents: 22000, capacity: 80 },
      { name: 'Ticket Home', priceCents: 12000, capacity: 150 },
      { name: 'Ticket Visitors', priceCents: 12000, capacity: 100 },
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
