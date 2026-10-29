import type { FastifyInstance } from 'fastify';
import { getEventById, listEvents } from './events.service.js';

export async function eventRoutes(app: FastifyInstance) {
  app.get('/events', async () => {
    return listEvents();
  });

  app.get<{ Params: { id: string } }>(
    '/events/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const event = await getEventById(request.params.id);

      if (!event) {
        return reply.code(404).send({
          error: 'Event not found',
        });
      }

      return event;
    },
  );
}