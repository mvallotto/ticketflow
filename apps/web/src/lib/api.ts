import type { Event, EventDetail } from '../types/event';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function getEvents(signal?: AbortSignal): Promise<Event[]> {
  const response = await fetch('/api/events', { signal });

  if (!response.ok) {
    throw new Error(`Failed to load events (${response.status})`);
  }

  return (await response.json()) as Event[];
}

export async function getEvent(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<EventDetail> {
    const response = await fetch(`/api/events/${eventId}`, { signal });
  
    if (!response.ok) {
      throw new Error(`Failed to load event (${response.status})`);
    }
  
    return (await response.json()) as EventDetail;
  }
  
  export type CreateOrderRequest = {
    visitorId: string;
    idempotencyKey: string;
    eventId: string;
    items: {
      ticketTypeId: string;
      quantity: number;
    }[];
  };
  
  export type CreatedOrder = {
    id: string;
    visitorId: string;
    idempotencyKey: string;
    status: string;
    totalCents: number;
    expiresAt: string;
    items: {
      ticketTypeId: string;
      quantity: number;
      unitPriceCents: number;
    }[];
  };
  
  export async function createOrder(
    request: CreateOrderRequest,
  ): Promise<CreatedOrder> {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
  
    if (!response.ok) {
      // Keep the status even when a proxy returns HTML instead of JSON.
      const data: unknown = await response.json().catch(() => null);
      const message =
        typeof data === 'object' &&
        data !== null &&
        'error' in data &&
        typeof data.error === 'string'
          ? data.error
          : `Failed to create order (${response.status})`;
  
      throw new ApiError(message, response.status);
    }
  
    return (await response.json()) as CreatedOrder;
}

export type ConfirmedOrder = {
    id: string;
    status: string;
    totalCents: number;
    confirmedAt?: string | null;
  };
  
  export async function confirmOrder(orderId: string): Promise<ConfirmedOrder> {
    const response = await fetch(`/api/orders/${orderId}/confirm`, {
      method: 'POST',
    });
  
    const data: unknown = await response.json();
  
    if (!response.ok) {
      const message =
        typeof data === 'object' &&
        data !== null &&
        'error' in data &&
        typeof data.error === 'string'
          ? data.error
          : `Failed to confirm order (${response.status})`;
  
      throw new Error(message);
    }
  
    return data as ConfirmedOrder;
}

export type OrderSummary = {
    id: string;
    eventId: string;
    status: 'PENDING' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
    totalCents: number;
    createdAt: string;
    expiresAt: string;
    confirmedAt: string | null;
  };
  
  export async function getOrdersByVisitor(
    visitorId: string,
    signal?: AbortSignal,
  ): Promise<OrderSummary[]> {
    const response = await fetch(
      `/api/orders?visitorId=${encodeURIComponent(visitorId)}`,
      { signal },
    );

    if (!response.ok) {
      throw new Error(`Failed to load orders (${response.status})`);
    }
  
    return (await response.json()) as OrderSummary[];
  }
