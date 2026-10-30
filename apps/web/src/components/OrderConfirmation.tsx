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
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-8">
      <p className="text-sm font-medium text-indigo-400">
        Order details
      </p>

      <h2 className="mt-3 text-2xl font-bold">
        {message.title}
      </h2>

      <p className="mt-3 text-slate-400">
        {message.description}
      </p>

      <div className="mt-6 space-y-3 rounded-lg bg-slate-800 p-5">
        <div>
          <p className="text-xs text-slate-400">Order ID</p>
          <p className="mt-1 break-all font-mono text-sm">
            {order.id}
          </p>
        </div>

        <div>
          <p className="text-xs text-slate-400">Status</p>
          <p className="mt-1 font-semibold">{status}</p>
        </div>

        <div>
          <p className="text-xs text-slate-400">Total</p>
          <p className="mt-1 font-semibold">
            {new Intl.NumberFormat('en-NL', {
              style: 'currency',
              currency: 'EUR',
            }).format(order.totalCents / 100)}
          </p>
        </div>

        {status === 'PENDING' && (
          <div>
            <p className="text-xs text-slate-400">
              Reservation expires at
            </p>
            <p className="mt-1 text-sm">
              {new Date(order.expiresAt).toLocaleString('en-GB')}
            </p>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-5 text-sm text-red-400">
          {error}
        </p>
      )}

      {status === 'PENDING' && (
        <button
          type="button"
          disabled={submitting}
          onClick={() => void handleConfirm()}
          className="mt-6 w-full rounded-lg bg-emerald-600 px-5 py-3 font-semibold hover:bg-emerald-500 disabled:opacity-50"
        >
          {submitting ? 'Confirming...' : 'Confirm booking'}
        </button>
      )}

      <button
        type="button"
        onClick={onBack}
        className="mt-4 w-full rounded-lg border border-slate-700 px-5 py-3 font-medium hover:bg-slate-800"
      >
        Back to events
      </button>
    </div>
  );
}
