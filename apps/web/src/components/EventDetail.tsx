import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  createOrder,
  getEvent,
  type CreatedOrder,
  type CreateOrderRequest,
} from '../lib/api';
import type { EventDetail as EventDetailType } from '../types/event';
import { useVisitor } from '../contexts/useVisitor';
import { clearPendingCheckout, loadPendingCheckout, savePendingCheckout } from '../lib/checkout-storage';

type EventDetailProps = {
  eventId: string;
  onBack: () => void;
  onOrderCreated: (order: CreatedOrder) => void;
};

function formatPrice(cents: number): string {
  return new Intl.NumberFormat('en-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(cents / 100);
}

export function EventDetail(props: EventDetailProps) {
  const { activeVisitor } = useVisitor();
  // Each visitor and event gets its own checkout state and pending callbacks.
  return (
    <VisitorEventDetail
      key={`${activeVisitor.id}:${props.eventId}`}
      {...props}
      visitorId={activeVisitor.id}
    />
  );
}

function VisitorEventDetail({
  eventId,
  onBack,
  onOrderCreated,
  visitorId,
}: EventDetailProps & { visitorId: string }) {
  const [event, setEvent] = useState<EventDetailType | null>(null);
  const [pendingRequest, setPendingRequest] = useState<CreateOrderRequest | null>(
    () => loadPendingCheckout(visitorId, eventId),
  );
  const [quantities, setQuantities] = useState<Record<string, number>>(() => Object.fromEntries(
    pendingRequest?.items.map(({ ticketTypeId, quantity }) => [ticketTypeId, quantity]) ?? [],
  ));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const inFlightRequestRef = useRef<CreateOrderRequest | null>(null);
  const availabilityRequestRef = useRef<AbortController | null>(null);
  const availabilityLoadedRef = useRef(false);
  const retryRequest =
    pendingRequest?.visitorId === visitorId && pendingRequest.eventId === eventId
      ? pendingRequest
      : null;

  const refreshAvailability = useCallback(() => {
    availabilityRequestRef.current?.abort();
    const controller = new AbortController();
    availabilityRequestRef.current = controller;

    return getEvent(eventId, controller.signal)
      .then((updatedEvent) => {
        // Ignore old responses even if fetch cancellation is not honored.
        if (controller.signal.aborted || availabilityRequestRef.current !== controller) return;
        availabilityLoadedRef.current = true;
        setEvent(updatedEvent);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted || availabilityRequestRef.current !== controller) return;
        if (!availabilityLoadedRef.current) {
          setError(err instanceof Error ? err.message : 'Unable to load event');
        } else {
          console.error('Failed to refresh availability', err);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && availabilityRequestRef.current === controller) {
          setLoading(false);
        }
      });
  }, [eventId]);

  useEffect(() => {
    void refreshAvailability();

    return () => availabilityRequestRef.current?.abort();
  }, [refreshAvailability]);

	useEffect(() => {
		const interval = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void refreshAvailability();
			}
		}, 15_000);

		function handleVisibilityChange() {
			if (document.visibilityState === 'visible') {
				void refreshAvailability();
			}
		}

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			clearInterval(interval);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [refreshAvailability]);

  useEffect(() => {
    return () => {
      inFlightRequestRef.current = null;
    };
  }, []);

  function updateQuantity(ticketTypeId: string, quantity: number) {
    if (inFlightRequestRef.current || retryRequest) return;
    setQuantities((current) => ({
      ...current,
      [ticketTypeId]: quantity,
    }));
    setCheckoutError(null);
  }

  const selectedItems =
    event?.ticketTypes
      .filter((ticket) => (quantities[ticket.id] ?? 0) > 0)
      .map((ticket) => ({
        ticketTypeId: ticket.id,
        quantity: quantities[ticket.id],
        unitPriceCents: ticket.priceCents,
      })) ?? [];

  const totalCents = selectedItems.reduce(
    (total, item) => total + item.quantity * item.unitPriceCents,
    0,
  );

	const hasInsufficientAvailability =
		event?.ticketTypes.some(
			(ticket) =>
				(quantities[ticket.id] ?? 0) > ticket.availableQuantity,
		) ?? false;

  async function handleCheckout() {
    if (
      !event ||
      inFlightRequestRef.current ||
      (!retryRequest && (selectedItems.length === 0 || hasInsufficientAvailability))
    ) {
      return;
    }

    setCheckoutError(null);

    const request: CreateOrderRequest = retryRequest ?? {
      visitorId,
      idempotencyKey: crypto.randomUUID(),
      eventId: event.id,
      items: selectedItems.map(({ ticketTypeId, quantity }) => ({
        ticketTypeId,
        quantity,
      })),
    };

    try {
      savePendingCheckout(request);
    } catch {
      setCheckoutError('Unable to save your reservation attempt. Please enable browser storage and try again.');
      return;
    }

    setSubmitting(true);
    // Block a second click before React updates the button.
    inFlightRequestRef.current = request;
    setPendingRequest(request);

    try {
      const order = await createOrder(request);

      if (inFlightRequestRef.current !== request) return;
      clearPendingCheckout(request);
      setPendingRequest(null);
      onOrderCreated(order);
    } catch (err) {
      if (inFlightRequestRef.current !== request) return;
      // Explicit rejections allow a new attempt; uncertain outcomes keep the retry key.
      if (err instanceof ApiError && [400, 404, 409].includes(err.status)) {
        clearPendingCheckout(request);
        setPendingRequest(null);
      }
      setCheckoutError(err instanceof Error ? err.message : 'Unable to create order');

      await refreshAvailability();
    } finally {
      if (inFlightRequestRef.current === request) {
        inFlightRequestRef.current = null;
        setSubmitting(false);
      }
    }
  }
		

  if (loading) {
    return <p className="text-slate-400">Loading tickets...</p>;
  }

  if (error || !event) {
    return (
      <div>
        <button onClick={onBack} className="mb-6 text-indigo-400">
          ← Back to events
        </button>
        <p role="alert" className="text-red-400">
          {error ?? 'Event not found'}
        </p>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-6 text-sm text-indigo-400 hover:text-indigo-300"
      >
        ← Back to events
      </button>

      <div className="mb-8">
        <h2 className="text-3xl font-bold">{event.title}</h2>
        <p className="mt-2 text-slate-400">{event.location}</p>
        <p className="mt-4 text-slate-300">{event.description}</p>
      </div>

      <div className="space-y-4">
        {event.ticketTypes.map((ticket) => {
          const quantity = quantities[ticket.id] ?? 0;

          return (
            <div
              key={ticket.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900 p-6"
            >
              <div>
                <h3 className="text-lg font-semibold">{ticket.name}</h3>
                <p className="mt-1 text-indigo-400">
                  {formatPrice(ticket.priceCents)}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  {ticket.availableQuantity} available
                </p>
              </div>

              <div className="flex items-center gap-4">
                <button
                  type="button"
                  disabled={quantity === 0 || submitting || retryRequest !== null}
                  onClick={() => updateQuantity(ticket.id, quantity - 1)}
                  className="h-10 w-10 rounded-lg bg-slate-800 text-xl disabled:opacity-40"
                >
                  −
                </button>

                <span className="w-6 text-center">{quantity}</span>

                <button
                  type="button"
                  disabled={
                    quantity >= ticket.availableQuantity ||
                    quantity >= 100 ||
                    submitting || retryRequest !== null
                  }
                  onClick={() => updateQuantity(ticket.id, quantity + 1)}
                  className="h-10 w-10 rounded-lg bg-slate-800 text-xl disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 rounded-xl border border-slate-700 bg-slate-900 p-6">
        <div className="flex items-center justify-between">
          <span className="text-lg font-medium">Total</span>
          <span className="text-2xl font-bold">
            {formatPrice(totalCents)}
          </span>
        </div>

        {checkoutError && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {checkoutError}
          </p>
        )}

        {retryRequest && !submitting && (
          <p role="status" className="mt-4 text-sm text-amber-400">
            We could not verify your reservation. Retry to recover the same
            reservation before changing ticket quantities.
          </p>
        )}
				{hasInsufficientAvailability && !retryRequest && (
					<p role="alert" className="mt-4 text-sm text-amber-400">
						Some tickets are no longer available in the selected quantity.
						Please adjust your selection.
					</p>
				)}

        <button
          type="button"
          disabled={
						submitting ||
            (!retryRequest && (selectedItems.length === 0 || hasInsufficientAvailability))
					}
          onClick={() => void handleCheckout()}
          className="mt-6 w-full rounded-lg bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'Reserving tickets...' : retryRequest ? 'Retry reservation' : 'Reserve tickets'}
        </button>
      </div>
    </div>
  );
}
