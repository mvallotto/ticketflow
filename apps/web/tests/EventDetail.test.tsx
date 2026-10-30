import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDetail } from '../src/components/EventDetail';
import { OrderConfirmation } from '../src/components/OrderConfirmation';
import type { CreateOrderRequest } from '../src/lib/api';
import { clearPendingCheckout, savePendingCheckout } from '../src/lib/checkout-storage';

const visitor = vi.hoisted(() => ({ id: '10000000-0000-4000-8000-000000000001', name: 'Visitor A' }));
vi.mock('../src/contexts/useVisitor', () => ({
  useVisitor: () => ({ activeVisitor: visitor }),
}));

const event = {
  id: '20000000-0000-4000-8000-000000000001', title: 'Test event', description: 'Test checkout', location: 'Amsterdam',
  ticketTypes: [{
    id: '30000000-0000-4000-8000-000000000001', name: 'General Admission', priceCents: 1000,
    capacity: 1, reservedQuantity: 0, soldQuantity: 0, availableQuantity: 1,
  }],
};

function availability(quantity: number) {
  return Response.json({
    ...event,
    ticketTypes: event.ticketTypes.map((ticket) => ({ ...ticket, availableQuantity: quantity })),
  });
}

function orderResponse(request: CreateOrderRequest) {
  return Response.json({
    ...request, id: 'original-order', status: 'PENDING', totalCents: 1000,
    expiresAt: '2027-01-01T12:00:00Z',
  }, { status: 201 });
}

function storageKey(visitorId = visitor.id, eventId = event.id) {
  return `ticketflow:checkout:${visitorId}:${eventId}`;
}

function savedRequest(): CreateOrderRequest {
  return {
    visitorId: visitor.id,
    eventId: event.id,
    idempotencyKey: '40000000-0000-4000-8000-000000000001',
    items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }],
  };
}

describe('Checkout recovery', () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: CreateOrderRequest[];
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const onOrderCreated = vi.fn();

  beforeEach(() => {
    visitor.id = '10000000-0000-4000-8000-000000000001';
    sessionStorage.clear();
    requests = [];
    onOrderCreated.mockReset();
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

  async function render(eventId = event.id) {
    await act(async () => {
      root.render(<EventDetail eventId={eventId} onBack={vi.fn()} onOrderCreated={onOrderCreated} />);
    });
  }

  function button(label: string) {
    const match = [...container.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === label);
    if (!match) throw new Error(`Button not found: ${label}`);
    return match;
  }

  async function click(label: string) {
    await act(async () => button(label).click());
  }

  async function refresh() {
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  }

  it('ignores an older availability response even if fetch ignores cancellation', async () => {
    const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
    fetchMock.mockResolvedValueOnce(availability(1)).mockImplementation(async (_url, options) =>
      new Promise<Response>((resolve) => pending.push({ resolve, signal: options!.signal! })),
    );
    await render();
    await click('+');
    await refresh();
    await refresh();
    expect(pending).toHaveLength(2);
    expect(pending[0].signal.aborted).toBe(true);

    await act(async () => pending[1].resolve(availability(0)));
    await act(async () => pending[0].resolve(availability(1)));
    expect(container.textContent).toContain('0 available');
    expect(container.querySelector('output[aria-label="General Admission quantity"]')?.textContent).toBe('1');
    expect(button('Reserve tickets').disabled).toBe(true);
  });

  it.each(['success', 'failure'])('ignores a late initial load %s after a newer refresh', async (outcome) => {
    let resolveInitial!: (response: Response) => void;
    let rejectInitial!: (error: Error) => void;
    fetchMock.mockImplementationOnce(async () => new Promise<Response>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    })).mockImplementation(async () => availability(0));
    await render();
    expect(container.textContent).toContain('Loading tickets');
    await refresh();
    expect(container.textContent).toContain('0 available');

    await act(async () => {
      if (outcome === 'success') resolveInitial(availability(1));
      else rejectInitial(new TypeError('Old request failed'));
    });
    expect(container.textContent).toContain('0 available');
    expect(container.textContent).not.toContain('Old request failed');
    expect(container.textContent).not.toContain('Loading tickets');
  });

  it('ignores a response from the previous event after switching events', async () => {
    let resolvePrevious!: (response: Response) => void;
    let previousSignal!: AbortSignal;
    const nextId = '20000000-0000-4000-8000-000000000002';
    fetchMock.mockImplementationOnce(async (_url, options) => {
      previousSignal = options!.signal!;
      return new Promise<Response>((resolve) => { resolvePrevious = resolve; });
    }).mockImplementation(async () => Response.json({ ...event, id: nextId, title: 'Next event' }));
    await render();
    await render(nextId);
    expect(previousSignal.aborted).toBe(true);
    await act(async () => resolvePrevious(availability(1)));
    expect(container.querySelector('h2')?.textContent).toBe('Next event');
  });

  it('shows the latest load error even when it supersedes a pending initial request', async () => {
    let resolveInitial!: (response: Response) => void;
    fetchMock.mockImplementationOnce(async () => new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    })).mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await render();
    await refresh();
    expect(container.textContent).toContain('Failed to load event (503)');
    await act(async () => resolveInitial(availability(1)));
    expect(container.textContent).toContain('Failed to load event (503)');
    expect(container.textContent).not.toContain('Loading tickets');
  });

  it('keeps loaded availability and selected quantities when a background refresh fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(availability(1))
      .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await render();
    await click('+');
    await refresh();

    expect(container.textContent).toContain('1 available');
    expect(container.querySelector('output[aria-label="General Admission quantity"]')?.textContent).toBe('1');
    expect(button('Reserve tickets').disabled).toBe(false);
    expect(container.textContent).not.toContain('Failed to load event');
  });

  it('does not let an old checkout refresh overwrite a newer polling response', async () => {
    let resolveCheckoutRefresh!: (response: Response) => void;
    let reads = 0;
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') throw new TypeError('Checkout response lost');
      reads++;
      if (reads === 1) return availability(1);
      if (reads === 2) {
        return new Promise<Response>((resolve) => { resolveCheckoutRefresh = resolve; });
      }
      return availability(0);
    });
    await render();
    await click('+');
    await click('Reserve tickets');
    await refresh();
    await act(async () => resolveCheckoutRefresh(availability(1)));

    expect(container.textContent).toContain('0 available');
    expect(button('Retry reservation').disabled).toBe(false);
  });

  it('polls only while the tab is visible', async () => {
    fetchMock.mockImplementation(async () => availability(1));
    await render();
    await act(async () => root.render(null));
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await render();
    const initialReads = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchMock).toHaveBeenCalledTimes(initialReads);
    visibility.mockReturnValue('visible');
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchMock).toHaveBeenCalledTimes(initialReads + 1);
  });

  it.each(['network', 'server', 'timeout', 'rate limit', 'non-JSON server', 'invalid success JSON'])(
    'reuses the original request after an ambiguous %s failure even with no availability',
    async (failure) => {
      fetchMock.mockImplementation(async (_url, options) => {
        if (options?.method !== 'POST') return availability(requests.length === 0 ? 1 : 0);
        const request = JSON.parse(options.body as string) as CreateOrderRequest;
        requests.push(request);
        if (requests.length > 1) return orderResponse(request);
        if (failure === 'network') throw new TypeError('Network response lost');
        if (failure === 'non-JSON server') return new Response('Gateway failure', { status: 502 });
        if (failure === 'invalid success JSON') return new Response('{', { status: 201 });
        const status = failure === 'server' ? 500 : failure === 'timeout' ? 408 : 429;
        return Response.json({ error: 'Unable to complete response' }, { status });
      });

      await render();
      await click('+');
      await click('Reserve tickets');

      expect(container.textContent).toContain('0 available');
      expect(button('Retry reservation').disabled).toBe(false);
      expect(JSON.parse(sessionStorage.getItem(storageKey())!).request).toEqual(requests[0]);
      expect(button('−').disabled).toBe(true);
      expect(onOrderCreated).not.toHaveBeenCalled();
      await click('Retry reservation');

      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[0].idempotencyKey).toBeTruthy();
      expect(onOrderCreated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'original-order' }));
      expect(sessionStorage.getItem(storageKey())).toBeNull();
    },
  );

  it.each([400, 404, 409])('allows a new attempt after an explicit HTTP %i rejection', async (status) => {
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method !== 'POST') return availability(1);
      const request = JSON.parse(options.body as string) as CreateOrderRequest;
      requests.push(request);
      if (requests.length > 1) return orderResponse(request);
      return Response.json({ error: 'Order rejected' }, { status });
    });

    await render();
    await click('+');
    await click('Reserve tickets');

    expect(container.textContent).toContain('Order rejected');
    expect(sessionStorage.getItem(storageKey())).toBeNull();
    expect(button('Reserve tickets').disabled).toBe(false);
    expect(button('−').disabled).toBe(false);
    await click('Reserve tickets');
    expect(requests).toHaveLength(2);
    expect(requests[1].idempotencyKey).not.toBe(requests[0].idempotencyKey);
    expect(onOrderCreated).toHaveBeenCalledOnce();
  });

  it('keeps a new checkout disabled when refreshed availability is insufficient', async () => {
    fetchMock.mockResolvedValueOnce(availability(1)).mockResolvedValue(availability(0));
    await render();
    await click('+');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(button('Reserve tickets').disabled).toBe(true);
    expect(container.textContent).toContain('Please adjust your selection');
    await click('Reserve tickets');
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  });

  it('preserves the original request when the availability refresh also fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method !== 'POST') {
        if (requests.length > 0) throw new TypeError('Availability unavailable');
        return availability(1);
      }
      const request = JSON.parse(options.body as string) as CreateOrderRequest;
      requests.push(request);
      if (requests.length === 1) throw new TypeError('Response lost');
      return orderResponse(request);
    });

    await render();
    await click('+');
    await click('Reserve tickets');
    expect(button('Retry reservation').disabled).toBe(false);
    await click('Retry reservation');
    expect(requests[1]).toEqual(requests[0]);
    expect(onOrderCreated).toHaveBeenCalledOnce();
  });

  it('ignores a late checkout response after switching visitor', async () => {
    let resolveOrder!: (response: Response) => void;
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method !== 'POST') return availability(1);
      requests.push(JSON.parse(options.body as string) as CreateOrderRequest);
      return new Promise<Response>((resolve) => { resolveOrder = resolve; });
    });
    await render();
    await click('+');
    await click('Reserve tickets');
    visitor.id = '10000000-0000-4000-8000-000000000002';
    await render();
    await act(async () => resolveOrder(orderResponse(requests[0])));

    expect(onOrderCreated).not.toHaveBeenCalled();
    // A different visitor starts with an empty selection.
    expect(button('Reserve tickets').disabled).toBe(true);
    expect(button('+').disabled).toBe(false);
    await click('+');
    expect(button('Reserve tickets').disabled).toBe(false);
    expect(button('−').disabled).toBe(false);
  });

  it.each(['lost response', 'in-flight request'])(
    'restores the original payload and key after remounting with a %s',
    async (scenario) => {
      let resolveOriginal: ((response: Response) => void) | undefined;
      fetchMock.mockImplementation(async (_url, options) => {
        if (options?.method !== 'POST') return availability(requests.length === 0 ? 1 : 0);
        const request = JSON.parse(options.body as string) as CreateOrderRequest;
        requests.push(request);
        // Persistence must precede the POST, including while it is in flight.
        expect(JSON.parse(sessionStorage.getItem(storageKey())!).request).toEqual(request);
        if (requests.length > 1) return orderResponse(request);
        if (scenario === 'lost response') throw new TypeError('Response lost');
        return new Promise<Response>((resolve) => { resolveOriginal = resolve; });
      });

      await render();
      await click('+');
      await click('Reserve tickets');
      await act(async () => root.render(null));
      await render();

      expect(container.textContent).toContain('0 available');
      expect(container.querySelector('output[aria-label="General Admission quantity"]')?.textContent).toBe('1');
      expect(button('Retry reservation').disabled).toBe(false);
      await click('Retry reservation');
      expect(requests[1]).toEqual(requests[0]);
      expect(sessionStorage.getItem(storageKey())).toBeNull();
      if (resolveOriginal) {
        await act(async () => resolveOriginal!(orderResponse(requests[0])));
      }
      expect(onOrderCreated).toHaveBeenCalledOnce();
    },
  );

  it('isolates saved attempts by visitor and event and restores them when returning', async () => {
    const request = savedRequest();
    savePendingCheckout(request);
    fetchMock.mockImplementation(async () => availability(0));
    await render();
    expect(button('Retry reservation').disabled).toBe(false);

    visitor.id = '10000000-0000-4000-8000-000000000002';
    await render();
    expect(button('Reserve tickets').disabled).toBe(true);
    visitor.id = request.visitorId;
    await render('20000000-0000-4000-8000-000000000002');
    expect(button('Reserve tickets').disabled).toBe(true);

    await render();
    expect(button('Retry reservation').disabled).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(storageKey())!).request).toEqual(request);
    expect(requests).toHaveLength(0);
  });

  it.each(['malformed JSON', 'unsupported version', 'wrong visitor', 'wrong event',
    'invalid key', 'empty items', 'duplicate items', 'invalid quantity', 'invalid ticket UUID'])(
    'ignores an invalid saved attempt: %s',
    async (invalidCase) => {
      const request = savedRequest();
      let version = 1;
      switch (invalidCase) {
        case 'unsupported version': version = 2; break;
        case 'wrong visitor': request.visitorId = '10000000-0000-4000-8000-000000000002'; break;
        case 'wrong event': request.eventId = '20000000-0000-4000-8000-000000000002'; break;
        case 'invalid key': request.idempotencyKey = 'not-a-uuid'; break;
        case 'empty items': request.items = []; break;
        case 'duplicate items': request.items.push({ ...request.items[0] }); break;
        case 'invalid quantity': request.items[0].quantity = -1; break;
        case 'invalid ticket UUID': request.items[0].ticketTypeId = 'not-a-uuid'; break;
      }
      sessionStorage.setItem(storageKey(), invalidCase === 'malformed JSON'
        ? '{' : JSON.stringify({ version, request }));
      fetchMock.mockResolvedValue(availability(1));

      await render();
      expect(button('Reserve tickets').disabled).toBe(true);
      expect(sessionStorage.getItem(storageKey())).toBeNull();
      await click('+');
      expect(button('Reserve tickets').disabled).toBe(false);
      expect(requests).toHaveLength(0);
    },
  );

  it('does not send a reservation if browser storage cannot save the request', async () => {
    fetchMock.mockResolvedValue(availability(1));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'QuotaExceededError');
    });
    await render();
    await click('+');
    await click('Reserve tickets');

    expect(container.textContent).toContain('Unable to save your reservation attempt');
    expect(button('Reserve tickets').disabled).toBe(false);
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  });

  it('does not clear a newer saved attempt when an older response completes', () => {
    const previous = savedRequest();
    const current = { ...previous, idempotencyKey: '40000000-0000-4000-8000-000000000002' };
    savePendingCheckout(current);
    clearPendingCheckout(previous);

    expect(JSON.parse(sessionStorage.getItem(storageKey())!).request).toEqual(current);
  });

  it('restores a saved checkout under StrictMode without sending an automatic reservation', async () => {
    const original = savedRequest();
    savePendingCheckout(original);
    fetchMock.mockImplementation(async () => availability(0));
    await act(async () => {
      root.render(
        <StrictMode>
          <EventDetail eventId={event.id} onBack={vi.fn()} onOrderCreated={onOrderCreated} />
        </StrictMode>,
      );
    });

    expect(container.querySelector('output[aria-label="General Admission quantity"]')?.textContent).toBe('1');
    expect(button('Retry reservation').disabled).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(storageKey())!).request).toEqual(original);
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  });

  it('preserves a restored retry when an old checkout completes after switching away and back', async () => {
    let resolveOriginal!: (response: Response) => void;
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method !== 'POST') return availability(requests.length === 0 ? 1 : 0);
      const request = JSON.parse(options.body as string) as CreateOrderRequest;
      requests.push(request);
      if (requests.length > 1) return orderResponse(request);
      return new Promise<Response>((resolve) => { resolveOriginal = resolve; });
    });
    await render();
    await click('+');
    await click('Reserve tickets');
    visitor.id = '10000000-0000-4000-8000-000000000002';
    await render();
    visitor.id = requests[0].visitorId;
    await render();
    await act(async () => resolveOriginal(orderResponse(requests[0])));

    expect(onOrderCreated).not.toHaveBeenCalled();
    expect(button('Retry reservation').disabled).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(storageKey())!).request).toEqual(requests[0]);
    await click('Retry reservation');
    expect(requests[1]).toEqual(requests[0]);
    expect(onOrderCreated).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(storageKey())).toBeNull();
  });

  it.each([
    ['EXPIRED', 'Reservation expired'],
    ['CONFIRMED', 'Booking confirmed!'],
    ['CANCELLED', 'Reservation cancelled'],
  ])('recovers a %s order using server status and clears the saved attempt', async (status, title) => {
    const original = savedRequest();
    savePendingCheckout(original);
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method !== 'POST') return availability(0);
      requests.push(JSON.parse(options.body as string) as CreateOrderRequest);
      return Response.json({
        ...original, id: 'original-order', status, totalCents: 1000,
        expiresAt: '2000-01-01T12:00:00Z',
        items: original.items.map((item) => ({ ...item, unitPriceCents: 1000 })),
      }, { status: 201 });
    });

    await render();
    await click('Retry reservation');
    expect(requests).toEqual([original]);
    expect(sessionStorage.getItem(storageKey())).toBeNull();
    expect(onOrderCreated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status }));
    await act(async () => {
      root.render(<OrderConfirmation order={onOrderCreated.mock.calls[0][0]} onBack={vi.fn()} />);
    });
    expect(container.querySelector('h2')?.textContent).toBe(title);
    expect(container.textContent).not.toContain('Confirm booking');
  });
});
