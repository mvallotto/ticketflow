import type { CreateOrderRequest } from './api';

function storageKey(visitorId: string, eventId: string): string {
  return `ticketflow:checkout:${visitorId}:${eventId}`;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isRequest(value: unknown): value is CreateOrderRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  if (!isUuid(request.visitorId) || !isUuid(request.eventId) ||
      !isUuid(request.idempotencyKey) || !Array.isArray(request.items) ||
      request.items.length < 1 || request.items.length > 20) return false;

  const ids = new Set<string>();
  return request.items.every((item: unknown) => {
    if (typeof item !== 'object' || item === null) return false;
    const entry = item as Record<string, unknown>;
    if (!isUuid(entry.ticketTypeId) || typeof entry.quantity !== 'number' ||
        !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 100 ||
        ids.has(entry.ticketTypeId)) return false;
    ids.add(entry.ticketTypeId);
    return true;
  });
}

export function loadPendingCheckout(visitorId: string, eventId: string): CreateOrderRequest | null {
  try {
    const key = storageKey(visitorId, eventId);
    const stored = sessionStorage.getItem(key);
    if (!stored) return null;
    let value: unknown;
    try {
      value = JSON.parse(stored);
    } catch {
      sessionStorage.removeItem(key);
      return null;
    }
    if (typeof value === 'object' && value !== null &&
        'version' in value && value.version === 1 && 'request' in value &&
        isRequest(value.request) && value.request.visitorId === visitorId &&
        value.request.eventId === eventId) {
      return value.request;
    }
    sessionStorage.removeItem(key);
  } catch {
    // Keep checkout usable when saved data cannot be read.
  }
  return null;
}

export function savePendingCheckout(request: CreateOrderRequest): void {
  // Save before the POST so a reload can retry with the original key and payload.
  sessionStorage.setItem(storageKey(request.visitorId, request.eventId), JSON.stringify({
    version: 1,
    request,
  }));
}

export function clearPendingCheckout(request: CreateOrderRequest): void {
  try {
    const stored = loadPendingCheckout(request.visitorId, request.eventId);
    // An old response must not erase a newer checkout attempt.
    if (stored?.idempotencyKey === request.idempotencyKey) {
      sessionStorage.removeItem(storageKey(request.visitorId, request.eventId));
    }
  } catch {
    // A saved request that already succeeded is safe to replay.
  }
}
