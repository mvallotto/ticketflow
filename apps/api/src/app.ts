import Fastify from 'fastify';
import { eventRoutes } from './modules/events/events.routes.js';
import { orderRoutes } from './modules/orders/orders.routes.js';

export function buildApp() {
  const app = Fastify({
    logger: true,
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.register(eventRoutes, { prefix: '/api' });
  app.register(orderRoutes, { prefix: '/api' });

  return app;
}
