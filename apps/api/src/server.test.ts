import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    listen: vi.fn<() => Promise<string>>(),
    close: vi.fn<() => Promise<void>>(),
    addHook: vi.fn<(name: string, hook: () => Promise<void>) => void>(),
    log: { info: vi.fn(), error: vi.fn() },
  },
  pool: { end: vi.fn<() => Promise<void>>() },
  expirePendingOrders: vi.fn<() => Promise<number>>(),
}));

vi.mock('./app.js', () => ({ buildApp: () => mocks.app }));
vi.mock('./db/client.js', () => ({ pool: mocks.pool }));
vi.mock('./modules/orders/orders.expiration.js', () => ({
  expirePendingOrders: mocks.expirePendingOrders,
}));

describe('Server shutdown', () => {
  let closeHook: () => Promise<void>;
  let start: Promise<unknown> | undefined;
  let releases: (() => void)[];
  let originalExitCode: typeof process.exitCode;
  let onSpy: MockInstance<typeof process.on>;
  let removeSpy: MockInstance<typeof process.removeListener>;
  let exitSpy: MockInstance<typeof process.exit>;

  function deferred<T>(fallback: T) {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    releases.push(() => resolve(fallback));
    return { promise, resolve };
  }

  function signal(name: 'SIGINT' | 'SIGTERM') {
    // Invoke only this module's listener; never send a real process signal.
    const handler = onSpy.mock.calls.find(([event]) => event === name)?.[1];
    if (!handler) throw new Error(`Signal handler not registered: ${name}`);
    handler(name);
  }

  async function shutdownCompleted() {
    const handler = onSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1];
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledWith('SIGTERM', handler));
  }

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    releases = [];
    start = undefined;
    originalExitCode = process.exitCode;
    closeHook = async () => {};
    mocks.app.addHook.mockImplementation((name, hook) => {
      if (name === 'onClose') closeHook = hook;
    });
    mocks.app.listen.mockResolvedValue('http://localhost:3000');
    mocks.app.close.mockImplementation(async () => { await closeHook(); });
    mocks.pool.end.mockResolvedValue();
    mocks.expirePendingOrders.mockResolvedValue(0);
    onSpy = vi.spyOn(process, 'on');
    removeSpy = vi.spyOn(process, 'removeListener');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Unexpected forced process exit');
    });
  });

  afterEach(async () => {
    for (const release of releases) release();
    if (start) {
      await start;
      signal('SIGTERM');
      await shutdownCompleted();
    }
    process.exitCode = originalExitCode;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('closes Fastify and the pool once on %s without forcing exit', async (name) => {
    start = import('./server.js');
    await start;
    signal(name);
    await shutdownCompleted();

    expect(mocks.app.close).toHaveBeenCalledOnce();
    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the running periodic cleanup before ending the pool and ignores repeated signals', async () => {
    start = import('./server.js');
    await start;
    const cleanup = deferred(0);
    mocks.expirePendingOrders.mockImplementationOnce(async () => cleanup.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.expirePendingOrders).toHaveBeenCalledTimes(2);

    signal('SIGTERM');
    signal('SIGINT');
    await vi.waitFor(() => expect(mocks.app.close).toHaveBeenCalledOnce());
    expect(mocks.pool.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.expirePendingOrders).toHaveBeenCalledTimes(2);

    cleanup.resolve(0);
    await shutdownCompleted();
    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(mocks.app.close).toHaveBeenCalledOnce();
  });

  it('does not schedule the interval after a signal during the initial cleanup', async () => {
    const cleanup = deferred(0);
    mocks.expirePendingOrders.mockImplementationOnce(async () => cleanup.promise);
    start = import('./server.js');
    await vi.waitFor(() => expect(mocks.expirePendingOrders).toHaveBeenCalledOnce());
    signal('SIGTERM');
    await vi.waitFor(() => expect(mocks.app.close).toHaveBeenCalledOnce());
    expect(mocks.pool.end).not.toHaveBeenCalled();

    cleanup.resolve(0);
    await start;
    await shutdownCompleted();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.expirePendingOrders).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for listener startup and skips cleanup when shutdown begins before listen resolves', async () => {
    const listener = deferred('http://localhost:3000');
    mocks.app.listen.mockImplementationOnce(async () => listener.promise);
    start = import('./server.js');
    await vi.waitFor(() => expect(mocks.app.listen).toHaveBeenCalledOnce());
    signal('SIGINT');
    expect(mocks.app.close).not.toHaveBeenCalled();

    listener.resolve('http://localhost:3000');
    await start;
    await shutdownCompleted();
    expect(mocks.expirePendingOrders).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the pool open until Fastify finishes draining requests', async () => {
    const requestsDrained = deferred(undefined);
    mocks.app.close.mockImplementation(async () => {
      await requestsDrained.promise;
      await closeHook();
    });
    start = import('./server.js');
    await start;
    signal('SIGTERM');
    await vi.waitFor(() => expect(mocks.app.close).toHaveBeenCalledOnce());
    expect(mocks.pool.end).not.toHaveBeenCalled();

    requestsDrained.resolve(undefined);
    await shutdownCompleted();
    expect(mocks.pool.end).toHaveBeenCalledOnce();
  });

  it('does not overlap periodic cleanup runs', async () => {
    start = import('./server.js');
    await start;
    const cleanup = deferred(0);
    mocks.expirePendingOrders.mockImplementationOnce(async () => cleanup.promise);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.expirePendingOrders).toHaveBeenCalledTimes(2);
    cleanup.resolve(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.expirePendingOrders).toHaveBeenCalledTimes(3);
  });

  it('logs cleanup failures but still shuts down cleanly', async () => {
    const error = new Error('Cleanup failed');
    mocks.expirePendingOrders.mockRejectedValueOnce(error);
    start = import('./server.js');
    await start;
    signal('SIGTERM');
    await shutdownCompleted();

    expect(mocks.app.log.error).toHaveBeenCalledWith({ error }, 'Failed to expire pending orders');
    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('resumes a bounded backlog on the next periodic cycle', async () => {
    mocks.expirePendingOrders.mockResolvedValue(100);
    start = import('./server.js');
    await start;
    expect(mocks.expirePendingOrders).toHaveBeenCalledTimes(10);
    expect(mocks.app.log.info).toHaveBeenCalledWith({
      expiredCount: 1000, batchesProcessed: 10, stopReason: 'batch-limit',
    }, 'Expired pending reservations');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.expirePendingOrders).toHaveBeenCalledTimes(20);
  });

  it('does not start another backlog batch after a signal during the current batch', async () => {
    start = import('./server.js');
    await start;
    const cleanup = deferred(100);
    mocks.expirePendingOrders.mockImplementationOnce(async () => cleanup.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    signal('SIGTERM');
    await vi.waitFor(() => expect(mocks.app.close).toHaveBeenCalledOnce());
    expect(mocks.pool.end).not.toHaveBeenCalled();
    cleanup.resolve(100);
    await shutdownCompleted();

    expect(mocks.expirePendingOrders).toHaveBeenCalledTimes(2);
    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(mocks.app.log.info).toHaveBeenCalledWith({
      expiredCount: 100, batchesProcessed: 1, stopReason: 'shutdown',
    }, 'Expired pending reservations');
  });

  it('releases the pool and reports a failed startup without forcing process exit', async () => {
    mocks.app.listen.mockRejectedValueOnce(new Error('Port unavailable'));
    start = import('./server.js');
    await start;
    await shutdownCompleted();

    expect(mocks.expirePendingOrders).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still waits for cleanup and closes the pool if Fastify close fails before onClose', async () => {
    start = import('./server.js');
    await start;
    const cleanup = deferred(0);
    mocks.expirePendingOrders.mockImplementationOnce(async () => cleanup.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    mocks.app.close.mockRejectedValueOnce(new Error('Fastify close failed'));
    signal('SIGTERM');
    await vi.waitFor(() => expect(mocks.app.close).toHaveBeenCalledOnce());
    expect(mocks.pool.end).not.toHaveBeenCalled();
    cleanup.resolve(0);
    await shutdownCompleted();

    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it('reports a pool close failure and removes signal listeners', async () => {
    const error = new Error('Pool close failed');
    mocks.pool.end.mockRejectedValueOnce(error);
    start = import('./server.js');
    await start;
    signal('SIGTERM');
    await shutdownCompleted();
    await vi.waitFor(() => expect(process.exitCode).toBe(1));

    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(mocks.app.log.error).toHaveBeenCalledWith({ error }, 'Failed to shut down server');
  });
});
