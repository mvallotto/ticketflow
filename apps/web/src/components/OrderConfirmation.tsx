import { useState } from 'react';
import {
  confirmOrder,
  type CreatedOrder,
  type ConfirmedOrder,
} from '../lib/api';

type OrderConfirmationProps = {
  order: CreatedOrder;
  onBack: () => void;
};

export function OrderConfirmation({
  order,
  onBack,
}: OrderConfirmationProps) {
  const [confirmedOrder, setConfirmedOrder] =
    useState<ConfirmedOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (submitting || confirmedOrder) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await confirmOrder(order.id);
      setConfirmedOrder(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to confirm order',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const status = confirmedOrder?.status ?? order.status;
  const messages: Record<string, { title: string; description: string }> = {
    PENDING: {
      title: 'Your tickets are reserved',
      description: 'Your reservation is pending confirmation.',
    },
    CONFIRMED: {
      title: 'Booking confirmed!',
      description: 'Your booking has been confirmed successfully.',
    },
    EXPIRED: {
      title: 'Reservation expired',
      description: 'This reservation has expired. Return to events to make a new reservation.',
    },
    CANCELLED: {
      title: 'Reservation cancelled',
      description: 'This reservation has been cancelled. Return to events to make a new reservation.',
    },
  };
  const message = messages[status] ?? { title: 'Order details', description: 'Check your order status below.' };

  return (
    <div className="order-confirmation">
      <p className="view-eyebrow">
        Order details
      </p>

      <h2 className="order-confirmation__title">
        {message.title}
      </h2>

      <p className="view-description">
        {message.description}
      </p>

      <div className="order-confirmation__details">
        <div>
          <p className="detail-label">Order ID</p>
          <p className="order-id">
            {order.id}
          </p>
        </div>

        <div>
          <p className="detail-label">Status</p>
          <p className="order-confirmation__value">{status}</p>
        </div>

        <div>
          <p className="detail-label">Total</p>
          <p className="order-confirmation__value">
            {new Intl.NumberFormat('en-NL', {
              style: 'currency',
              currency: 'EUR',
            }).format(order.totalCents / 100)}
          </p>
        </div>

        {status === 'PENDING' && (
          <div>
            <p className="detail-label">
              Reservation expires at
            </p>
            <p className="order-confirmation__expiry">
              {new Date(order.expiresAt).toLocaleString('en-GB')}
            </p>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="order-confirmation__error">
          {error}
        </p>
      )}

      {status === 'PENDING' && (
        <button
          type="button"
          disabled={submitting}
          onClick={() => void handleConfirm()}
          className="button button--confirm order-confirmation__confirm"
        >
          {submitting ? 'Confirming...' : 'Confirm booking'}
        </button>
      )}

      <button
        type="button"
        onClick={onBack}
        className="button button--secondary order-confirmation__back"
      >
        Back to events
      </button>
    </div>
  );
}
