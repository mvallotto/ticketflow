import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MyOrders } from '../src/components/MyOrders';
import type { OrderSummary } from '../src/lib/api';

const visitor = vi.hoisted(() => ({ id: 'visitor-a', name: 'Visitor A' }));
vi.mock('../src/contexts/useVisitor', () => ({
  useVisitor: () => ({ activeVisitor: visitor }),
}));

function order(id: string, status: OrderSummary['status'] = 'PENDING'): OrderSummary {
  return {
    id, status, eventId: 'event-a', totalCents: 1000,
    createdAt: '2026-01-01T12:00:00Z', expiresAt: '2099-01-01T12:00:00Z',
    confirmedAt: status === 'CONFIRMED' ? '2026-01-01T12:01:00Z' : null,
  };
}

function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('My orders request safety', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    visitor.id = 'visitor-a';
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(<MyOrders />));
  }

  function button(label: string) {
    const result = [...container.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === label);
    if (!result) throw new Error(`Button not found: ${label}`);
    return result;
  }

  async function click(label: string) {
    await act(async () => button(label).click());
  }

  it.each(['success', 'failure'])('ignores a late initial load %s from the previous visitor', async (outcome) => {
    const previous = deferred();
    fetchMock.mockImplementationOnce(async () => previous.promise)
      .mockImplementation(async () => Response.json([order('order-b')]));
    await render();
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    visitor.id = 'visitor-b';
    await render();
    expect(signal.aborted).toBe(true);

    await act(async () => {
      if (outcome === 'success') previous.resolve(Response.json([order('order-a')]));
      else previous.reject(new TypeError('Previous visitor failed'));
    });
    expect(container.textContent).toContain('order-b');
    expect(container.textContent).not.toContain('order-a');
    expect(container.textContent).not.toContain('Previous visitor failed');
  });

  it('does not show the previous visitor orders when the new visitor load fails', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockRejectedValueOnce(new TypeError('Visitor B unavailable'));
    await render();
    visitor.id = 'visitor-b';
    await render();

    expect(container.textContent).not.toContain('order-a');
    expect(container.textContent).toContain('Visitor B unavailable');
    expect(button('Refresh orders').disabled).toBe(false);
  });

  it.each(['success', 'failure'])('ignores a manual refresh %s after switching visitors', async (outcome) => {
    const previous = deferred();
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockImplementationOnce(async () => previous.promise)
      .mockImplementation(async () => Response.json([order('order-b')]));
    await render();
    await click('Refresh orders');
    visitor.id = 'visitor-b';
    await render();

    await act(async () => {
      if (outcome === 'success') previous.resolve(Response.json([order('stale-order-a')]));
      else previous.reject(new TypeError('Previous refresh failed'));
    });
    expect(container.textContent).toContain('order-b');
    expect(container.textContent).not.toContain('order-a');
    expect(container.textContent).not.toContain('Previous refresh failed');
  });

  it('keeps the latest refresh when responses arrive out of order for the same visitor', async () => {
    const older = deferred();
    fetchMock.mockResolvedValueOnce(Response.json([order('original')]))
      .mockImplementationOnce(async () => older.promise)
      .mockResolvedValueOnce(Response.json([order('latest')]));
    await render();
    await click('Refresh orders');
    await click('Refresh orders');
    expect(fetchMock.mock.calls[1][1]!.signal!.aborted).toBe(true);
    await act(async () => older.resolve(Response.json([order('stale')])));

    expect(container.textContent).toContain('latest');
    expect(container.textContent).not.toContain('stale');
  });

  it('handles a manual refresh failure, keeps loaded orders and clears the error on retry', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockRejectedValueOnce(new TypeError('Refresh offline'))
      .mockResolvedValueOnce(Response.json([order('order-a', 'CONFIRMED')]));
    await render();
    await click('Refresh orders');
    expect(container.textContent).toContain('order-a');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Refresh offline');
    await click('Refresh orders');
    expect(container.textContent).toContain('CONFIRMED');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['empty', 'failed'])('offers manual retry after an %s initial load', async (scenario) => {
    if (scenario === 'empty') fetchMock.mockResolvedValueOnce(Response.json([]));
    else fetchMock.mockRejectedValueOnce(new TypeError('Initial load failed'));
    fetchMock.mockResolvedValueOnce(Response.json([order('recovered')]));
    await render();
    await click('Refresh orders');

    expect(container.textContent).toContain('recovered');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('refreshes orders after confirmation succeeds', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockResolvedValueOnce(Response.json(order('order-a', 'CONFIRMED')))
      .mockResolvedValueOnce(Response.json([order('order-a', 'CONFIRMED')]));
    await render();
    await click('Confirm booking');

    expect(fetchMock.mock.calls[1][0]).toBe('/api/orders/order-a/confirm');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
    expect(container.textContent).toContain('CONFIRMED');
    expect(container.textContent).not.toContain('Confirm booking');
  });

  it('ignores a read started before confirmation instead of restoring the pending status', async () => {
    const previousRead = deferred();
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockImplementationOnce(async () => previousRead.promise)
      .mockResolvedValueOnce(Response.json(order('order-a', 'CONFIRMED')))
      .mockResolvedValueOnce(Response.json([order('order-a', 'CONFIRMED')]));
    await render();
    await click('Refresh orders');
    const previousSignal = fetchMock.mock.calls[1][1]!.signal!;
    await click('Confirm booking');
    expect(previousSignal.aborted).toBe(true);
    await act(async () => previousRead.resolve(Response.json([order('order-a')])));

    expect(container.textContent).toContain('CONFIRMED');
    expect(container.textContent).not.toContain('Confirm booking');
  });

  it('ignores a follow-up confirmation refresh after the visitor changes', async () => {
    const previousRead = deferred();
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockResolvedValueOnce(Response.json(order('order-a', 'CONFIRMED')))
      .mockImplementationOnce(async () => previousRead.promise)
      .mockResolvedValueOnce(Response.json([order('order-b')]));
    await render();
    await click('Confirm booking');
    visitor.id = 'visitor-b';
    await render();
    await act(async () => previousRead.resolve(Response.json([order('order-a', 'CONFIRMED')])));

    expect(container.textContent).toContain('order-b');
    expect(container.textContent).not.toContain('order-a');
    expect(button('Confirm booking').disabled).toBe(false);
  });

  it('does not let an old confirmation unlock a new visitor confirmation', async () => {
    const previousConfirmation = deferred();
    const currentConfirmation = deferred();
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockImplementationOnce(async () => previousConfirmation.promise)
      .mockResolvedValueOnce(Response.json([order('order-b')]))
      .mockImplementationOnce(async () => currentConfirmation.promise)
      .mockResolvedValueOnce(Response.json([order('order-b', 'CONFIRMED')]));
    await render();
    await click('Confirm booking');
    visitor.id = 'visitor-b';
    await render();
    await click('Confirm booking');
    await act(async () => previousConfirmation.resolve(Response.json(order('order-a', 'CONFIRMED'))));

    expect(button('Confirming...').disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => currentConfirmation.resolve(Response.json(order('order-b', 'CONFIRMED'))));
    expect(container.textContent).toContain('CONFIRMED');
    expect(container.textContent).not.toContain('Confirming...');
  });

  it('preserves a confirmation error while refreshing the expired order status', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockResolvedValueOnce(Response.json({ error: 'Order has expired' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json([order('order-a', 'EXPIRED')]));
    await render();
    await click('Confirm booking');

    expect(container.textContent).toContain('EXPIRED');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Order has expired');
    expect(container.textContent).not.toContain('Confirm booking');
  });

  it('preserves both confirmation and follow-up refresh failures and unlocks the action', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockRejectedValueOnce(new TypeError('Confirmation offline'))
      .mockRejectedValueOnce(new TypeError('Refresh offline'));
    await render();
    await click('Confirm booking');

    const message = container.querySelector('[role="alert"]')?.textContent;
    expect(message).toContain('Confirmation offline');
    expect(message).toContain('Refresh offline');
    expect(button('Confirm booking').disabled).toBe(false);
  });

  it.each(['success', 'failure'])('ignores a late confirmation %s without refreshing the previous visitor', async (outcome) => {
    const confirmation = deferred();
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockImplementationOnce(async () => confirmation.promise)
      .mockResolvedValueOnce(Response.json([order('order-b')]));
    await render();
    await click('Confirm booking');
    visitor.id = 'visitor-b';
    await render();
    await act(async () => {
      if (outcome === 'success') confirmation.resolve(Response.json(order('order-a', 'CONFIRMED')));
      else confirmation.reject(new TypeError('Previous confirmation failed'));
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('order-b');
    expect(container.textContent).not.toContain('order-a');
    expect(container.textContent).not.toContain('Previous confirmation failed');
    expect(button('Confirm booking').disabled).toBe(false);
  });

  it('does not send duplicate confirmation requests for two clicks in the same render', async () => {
    const confirmation = deferred();
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockImplementationOnce(async () => confirmation.promise)
      .mockResolvedValueOnce(Response.json([order('order-a', 'CONFIRMED')]));
    await render();
    const confirm = button('Confirm booking');
    await act(async () => { confirm.click(); confirm.click(); });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    await act(async () => confirmation.resolve(Response.json(order('order-a', 'CONFIRMED'))));
    expect(container.textContent).toContain('CONFIRMED');
  });

  it('aborts an outstanding read when the component unmounts', async () => {
    const pending = deferred();
    fetchMock.mockImplementation(async () => pending.promise);
    await render();
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(Response.json([order('order-a')])));
    expect(container.textContent).toBe('');
  });

  it('hides confirmation at the deadline without changing the server order status', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-10-30T12:00:00Z');
    vi.setSystemTime(start);
    fetchMock.mockResolvedValueOnce(Response.json([{
      ...order('order-a'), expiresAt: new Date(start.getTime() + 2000).toISOString(),
    }]));
    await render();
    expect(button('Confirm booking').disabled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(button('Confirm booking').disabled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(container.textContent).not.toContain('Confirm booking');
    expect(container.textContent).toContain('PENDING');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('updates the displayed deadline when the tab becomes visible again', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-10-30T12:00:00Z');
    vi.setSystemTime(start);
    fetchMock.mockResolvedValueOnce(Response.json([{
      ...order('order-a'), expiresAt: new Date(start.getTime() + 2000).toISOString(),
    }]));
    await render();
    vi.setSystemTime(new Date(start.getTime() + 5000));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));

    expect(container.textContent).not.toContain('Confirm booking');
    expect(container.textContent).toContain('PENDING');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('removes the clock timer when pending orders disappear or the component unmounts', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json([order('order-a')]))
      .mockResolvedValueOnce(Response.json([order('order-a', 'CONFIRMED')]))
      .mockResolvedValueOnce(Response.json([order('order-a')]));
    await render();
    expect(vi.getTimerCount()).toBe(1);
    await click('Refresh orders');
    expect(vi.getTimerCount()).toBe(0);
    await click('Refresh orders');
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not revive an old request after switching away and back to the same visitor', async () => {
    const previous = deferred();
    fetchMock.mockImplementationOnce(async () => previous.promise)
      .mockResolvedValueOnce(Response.json([order('order-b')]))
      .mockResolvedValueOnce(Response.json([order('current-order-a')]));
    await render();
    visitor.id = 'visitor-b';
    await render();
    visitor.id = 'visitor-a';
    await render();
    await act(async () => previous.resolve(Response.json([order('obsolete-order-a')])));

    expect(container.textContent).toContain('current-order-a');
    expect(container.textContent).not.toContain('obsolete-order-a');
    expect(container.textContent).not.toContain('order-b');
  });
});
