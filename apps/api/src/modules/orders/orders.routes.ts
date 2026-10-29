
import type { FastifyInstance } from 'fastify';
import {
  createOrder,
  OrderError,
  type CreateOrderInput,
} from './orders.service.js';

export async function orderRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateOrderInput }>(
    '/orders',
    {
      schema: {
        body: {
          type: 'object',
          required: ['eventId', 'items'],
          additionalProperties: false,
          properties: {
            eventId: {
              type: 'string',
              format: 'uuid',
            },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                required: ['ticketTypeId', 'quantity'],
                additionalProperties: false,
                properties: {
                  ticketTypeId: {
                    type: 'string',
                    format: 'uuid',
                  },
                  quantity: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 100,
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const order = await createOrder(request.body);

        return reply.code(201).send(order);
      } catch (error) {
        if (error instanceof OrderError) {
          return reply.code(error.statusCode).send({
            error: error.message,
          });
        }

        throw error;
      }
    },
  );
}
