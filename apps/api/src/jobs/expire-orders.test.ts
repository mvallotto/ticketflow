import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processExpirationBacklog: vi.fn<() => Promise<{
    expiredCount: number;
    batchesProcessed: number;
    stopReason: 'no-progress' | 'batch-limit' | 'shutdown';
  }>>(),
  end: vi.fn<() => Promise<void>>(),
}));
vi.mock('./expiration-cleanup.js', () => ({ processExpirationBacklog: mocks.processExpirationBacklog }));
vi.mock('../db/client.js', () => ({ pool: { end: mocks.end } }));

describe('Manual expiration command', () => {
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    originalExitCode = process.exitCode;
    mocks.processExpirationBacklog.mockResolvedValue({
      expiredCount: 25, batchesProcessed: 2, stopReason: 'no-progress',
    });
    mocks.end.mockResolvedValue();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('uses the shared cleanup and closes the pool', async () => {
    await import('./expire-orders.js');
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledOnce());
    expect(mocks.processExpirationBacklog).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledExactlyOnceWith('Expired 25 orders');
  });

  it('reports the cycle limit without claiming the entire backlog was drained', async () => {
    mocks.processExpirationBacklog.mockResolvedValue({
      expiredCount: 1000, batchesProcessed: 10, stopReason: 'batch-limit',
    });
    await import('./expire-orders.js');
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledOnce());
    expect(console.log).toHaveBeenCalledWith('Expired 1000 orders');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('run orders:expire again'));
  });

  it('closes the pool and reports a cleanup failure', async () => {
    const error = new Error('Cleanup failed');
    mocks.processExpirationBacklog.mockRejectedValueOnce(error);
    await import('./expire-orders.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith('Order cleanup failed:', error);
  });

  it('reports a pool close failure without an unhandled rejection', async () => {
    const error = new Error('Pool close failed');
    mocks.end.mockRejectedValueOnce(error);
    await import('./expire-orders.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(console.error).toHaveBeenCalledWith('Order cleanup failed:', error);
  });
});
