import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processExpirationBacklog } from './expiration-cleanup.js';

const expireBatch = vi.hoisted(() => vi.fn<(limit: number) => Promise<number>>());
vi.mock('../modules/orders/orders.expiration.js', () => ({ expirePendingOrders: expireBatch }));

describe('Expiration backlog processing', () => {
  beforeEach(() => { expireBatch.mockReset(); });

  it('uses 100 orders per batch and stops when no progress is made', async () => {
    expireBatch.mockResolvedValueOnce(100).mockResolvedValueOnce(100)
      .mockResolvedValueOnce(25).mockResolvedValueOnce(0);

    expect(await processExpirationBacklog()).toEqual({
      expiredCount: 225, batchesProcessed: 4, stopReason: 'no-progress',
    });
    expect(expireBatch).toHaveBeenCalledTimes(4);
    for (const [limit] of expireBatch.mock.calls) expect(limit).toBe(100);
  });

  it('does not assume a partially processed batch means the backlog is empty', async () => {
    expireBatch.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    expect(await processExpirationBacklog({ batchSize: 2 })).toEqual({
      expiredCount: 3, batchesProcessed: 3, stopReason: 'no-progress',
    });
  });

  it('bounds the default cycle to ten batches even with a continuous backlog', async () => {
    expireBatch.mockResolvedValue(100);
    expect(await processExpirationBacklog()).toEqual({
      expiredCount: 1000, batchesProcessed: 10, stopReason: 'batch-limit',
    });
    expect(expireBatch).toHaveBeenCalledTimes(10);
  });

  it('supports a smaller batch budget', async () => {
    expireBatch.mockResolvedValue(2);
    expect(await processExpirationBacklog({ batchSize: 2, maxBatches: 2 })).toEqual({
      expiredCount: 4, batchesProcessed: 2, stopReason: 'batch-limit',
    });
    expect(expireBatch.mock.calls).toEqual([[2], [2]]);
  });

  it('does not start a batch after shutdown has begun', async () => {
    expect(await processExpirationBacklog({ shouldStop: () => true })).toEqual({
      expiredCount: 0, batchesProcessed: 0, stopReason: 'shutdown',
    });
    expect(expireBatch).not.toHaveBeenCalled();
  });

  it('finishes the current batch but does not start another after shutdown', async () => {
    let stopping = false;
    expireBatch.mockImplementationOnce(async () => { stopping = true; return 100; });
    expect(await processExpirationBacklog({ shouldStop: () => stopping })).toEqual({
      expiredCount: 100, batchesProcessed: 1, stopReason: 'shutdown',
    });
    expect(expireBatch).toHaveBeenCalledOnce();
  });

  it('does not busy-loop when another worker has already processed selected orders', async () => {
    expireBatch.mockResolvedValue(0);
    expect(await processExpirationBacklog()).toEqual({
      expiredCount: 0, batchesProcessed: 1, stopReason: 'no-progress',
    });
    expect(expireBatch).toHaveBeenCalledOnce();
  });

  it('propagates a failed batch without starting another', async () => {
    const error = new Error('Database unavailable');
    expireBatch.mockResolvedValueOnce(100).mockRejectedValueOnce(error);
    await expect(processExpirationBacklog()).rejects.toBe(error);
    expect(expireBatch).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid batch settings before touching the database: %s', async (invalid) => {
      await expect(processExpirationBacklog({ batchSize: invalid })).rejects.toBeInstanceOf(RangeError);
      await expect(processExpirationBacklog({ maxBatches: invalid })).rejects.toBeInstanceOf(RangeError);
      expect(expireBatch).not.toHaveBeenCalled();
    },
  );
});
