import { expirePendingOrders } from '../modules/orders/orders.expiration.js';

type CleanupOptions = {
  batchSize?: number;
  maxBatches?: number;
  shouldStop?: () => boolean;
};

type CleanupResult = {
  expiredCount: number;
  batchesProcessed: number;
  stopReason: 'no-progress' | 'batch-limit' | 'shutdown';
};

export async function processExpirationBacklog({
  batchSize = 100,
  maxBatches = 10,
  shouldStop = () => false,
}: CleanupOptions = {}): Promise<CleanupResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 ||
      !Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new RangeError('Cleanup batch size and batch limit must be positive safe integers');
  }

  let expiredCount = 0;
  let batchesProcessed = 0;
  while (batchesProcessed < maxBatches) {
    if (shouldStop()) return { expiredCount, batchesProcessed, stopReason: 'shutdown' };

    const count = await expirePendingOrders(batchSize);
    batchesProcessed++;
    expiredCount += count;
    // Another worker may process some selected rows, so a partial count does not
    // mean the backlog is empty. Continue until no progress, shutdown or the limit.
    if (count === 0) return { expiredCount, batchesProcessed, stopReason: 'no-progress' };
  }

  return { expiredCount, batchesProcessed, stopReason: 'batch-limit' };
}
