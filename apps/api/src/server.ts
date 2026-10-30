import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { processExpirationBacklog } from './jobs/expiration-cleanup.js';

const app = buildApp();

const CLEANUP_INTERVAL_MS = 30_000;

let cleanupInterval: ReturnType<typeof setInterval> | undefined;
let cleanupPromise: Promise<void> | undefined;
let listenPromise: Promise<string> | undefined;
let shutdownPromise: Promise<void> | undefined;
let resourceClosePromise: Promise<void> | undefined;
let shuttingDown = false;

function runExpirationCleanup(): Promise<void> {
  if (shuttingDown) return Promise.resolve();
  if (cleanupPromise) return cleanupPromise;

  cleanupPromise = Promise.resolve()
    .then(() => processExpirationBacklog({ shouldStop: () => shuttingDown }))
    .then(({ expiredCount, batchesProcessed, stopReason }) => {
      if (expiredCount > 0) {
        app.log.info({ expiredCount, batchesProcessed, stopReason }, 'Expired pending reservations');
      }
    })
    .catch((error) => {
      app.log.error({ error }, 'Failed to expire pending orders');
    })
    .finally(() => { cleanupPromise = undefined; });

  return cleanupPromise;
}

function stopCleanup() {
  shuttingDown = true;
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
}

function closeResources(): Promise<void> {
  // The close hook and shutdown fallback must share one pool-closing operation.
  resourceClosePromise ??= (async () => {
    await cleanupPromise;
    await pool.end();
  })();
  return resourceClosePromise;
}

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopCleanup();
  shutdownPromise = (async () => {
    try {
      // Let listener startup settle before closing Fastify.
      await listenPromise?.catch(() => undefined);
      await app.close();
    } finally {
      try {
        // Close resources even if Fastify fails before running onClose.
        await closeResources();
      } finally {
        process.removeListener('SIGINT', handleShutdownSignal);
        process.removeListener('SIGTERM', handleShutdownSignal);
      }
    }
  })().catch((error) => {
    app.log.error({ error }, 'Failed to shut down server');
    process.exitCode = 1;
  });
  return shutdownPromise;
}

function handleShutdownSignal(signal: NodeJS.Signals) {
  if (!shuttingDown) app.log.info({ signal }, 'Shutting down server');
  void shutdown();
}

// Fastify requires lifecycle hooks to be registered before listen().
app.addHook('onClose', async () => {
  stopCleanup();
  await closeResources();
});
process.on('SIGINT', handleShutdownSignal);
process.on('SIGTERM', handleShutdownSignal);

try {
  listenPromise = app.listen({
    port: 3000,
    host: '0.0.0.0',
  });
  await listenPromise;

  // Recover expired reservations left by earlier server runs.
  await runExpirationCleanup();

  // A signal during the initial cleanup must not restart the timer.
  if (!shuttingDown) {
    cleanupInterval = setInterval(() => {
      void runExpirationCleanup();
    }, CLEANUP_INTERVAL_MS);
  }
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await shutdown();
}
