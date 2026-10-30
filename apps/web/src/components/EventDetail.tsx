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
    return <p className="message">Loading tickets...</p>;
  }

  if (error || !event) {
    return (
      <div>
        <button onClick={onBack} className="back-link back-link--load-error">
          ← Back to events
        </button>
        <p role="alert" className="message message--error">
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
        className="back-link"
      >
        ← Back to events
      </button>

      <div className="view-heading">
        <h2 className="event-detail__title">{event.title}</h2>
        <p className="event-detail__location">{event.location}</p>
        <p className="event-detail__description">{event.description}</p>
      </div>

      <div className="card-list">
        {event.ticketTypes.map((ticket) => {
          const quantity = quantities[ticket.id] ?? 0;

          return (
            <div
              key={ticket.id}
              className="ticket-card"
            >
              <div>
                <h3 className="ticket-card__title">{ticket.name}</h3>
                <p className="ticket-card__price">
                  {formatPrice(ticket.priceCents)}
                </p>
                <p className="ticket-card__availability">
                  {ticket.availableQuantity} available
                </p>
              </div>

              <div className="ticket-card__controls">
                <button
                  type="button"
                  disabled={quantity === 0 || submitting || retryRequest !== null}
                  onClick={() => updateQuantity(ticket.id, quantity - 1)}
                  className="ticket-card__quantity-button"
                >
                  −
                </button>

                <output className="ticket-card__quantity" aria-label={`${ticket.name} quantity`}>{quantity}</output>

                <button
                  type="button"
                  disabled={
                    quantity >= ticket.availableQuantity ||
                    quantity >= 100 ||
                    submitting || retryRequest !== null
                  }
                  onClick={() => updateQuantity(ticket.id, quantity + 1)}
                  className="ticket-card__quantity-button"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="checkout-summary">
        <div className="checkout-summary__total">
          <span className="checkout-summary__label">Total</span>
          <span className="checkout-summary__amount">
            {formatPrice(totalCents)}
          </span>
        </div>

        {checkoutError && (
          <p role="alert" className="checkout-message checkout-message--error">
            {checkoutError}
          </p>
        )}

        {retryRequest && !submitting && (
          <p role="status" className="checkout-message checkout-message--warning">
            We could not verify your reservation. Retry to recover the same
            reservation before changing ticket quantities.
          </p>
        )}
				{hasInsufficientAvailability && !retryRequest && (
					<p role="alert" className="checkout-message checkout-message--warning">
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
          className="button button--primary checkout-summary__submit"
        >
          {submitting ? 'Reserving tickets...' : retryRequest ? 'Retry reservation' : 'Reserve tickets'}
        </button>
      </div>
    </div>
  );
}
