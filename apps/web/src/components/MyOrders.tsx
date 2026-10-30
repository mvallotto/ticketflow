import { useCallback, useEffect, useRef, useState } from 'react';
import {
  confirmOrder,
  getOrdersByVisitor,
  type OrderSummary,
} from '../lib/api';
import { useVisitor, type Visitor } from '../contexts/useVisitor';

function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(cents / 100);
}

export function MyOrders() {
  const { activeVisitor } = useVisitor();
  // A visitor change starts a fresh view instead of resetting state in an effect.
  return <VisitorOrders key={activeVisitor.id} activeVisitor={activeVisitor} />;
}

function VisitorOrders({ activeVisitor }: { activeVisitor: Visitor }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const visitorScopeRef = useRef<object | null>(null);
  const ordersRequestRef = useRef<AbortController | null>(null);
  const confirmationRef = useRef<object | null>(null);

  const refreshOrders = useCallback((preserveError = false) => {
    const scope = visitorScopeRef.current;
    if (!scope) return Promise.resolve();
    ordersRequestRef.current?.abort();
    const controller = new AbortController();
    ordersRequestRef.current = controller;

    function isCurrent() {
      // Both the visitor scope and the latest request must still match.
      return visitorScopeRef.current === scope && !controller.signal.aborted &&
        ordersRequestRef.current === controller;
    }

    return getOrdersByVisitor(activeVisitor.id, controller.signal)
      .then((data) => {
        if (isCurrent()) {
          setOrders(data);
          if (!preserveError) setError(null);
        }
      })
      .catch((err) => {
        if (isCurrent()) {
          const message = err instanceof Error ? err.message : 'Unable to load orders';
          setError((current) => preserveError && current
            ? `${current} Unable to refresh orders: ${message}` : message);
        }
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
  }, [activeVisitor.id]);

  useEffect(() => {
    const scope = {};
    visitorScopeRef.current = scope;
    confirmationRef.current = null;
    void refreshOrders();

    return () => {
      ordersRequestRef.current?.abort();
      visitorScopeRef.current = null;
      confirmationRef.current = null;
    };
  }, [activeVisitor.id, refreshOrders]);

  const hasPendingOrders = orders.some((order) => order.status === 'PENDING');
  // This clock controls the button only; the API decides whether an order has expired.
  useEffect(() => {
    if (!hasPendingOrders) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') setNow(Date.now());
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [hasPendingOrders]);

  async function handleConfirm(orderId: string) {
    const scope = visitorScopeRef.current;
    if (!scope || confirmationRef.current) return;
    const confirmation = {};
    confirmationRef.current = confirmation;
    // Discard reads that may still report the status from before confirmation.
    ordersRequestRef.current?.abort();
    setConfirmingId(orderId);
    setError(null);

    try {
      await confirmOrder(orderId);
    } catch (err) {
      if (visitorScopeRef.current === scope) {
        setError(err instanceof Error ? err.message : 'Unable to confirm order');
      }
    } finally {
      if (visitorScopeRef.current === scope) {
        await refreshOrders(true);
        if (visitorScopeRef.current === scope && confirmationRef.current === confirmation) {
          confirmationRef.current = null;
          setConfirmingId(null);
        }
      }
    }
  }

  if (loading) {
    return <p className="text-slate-400">Loading orders...</p>;
  }

  return (
    <div>
      <div className="mb-8">
        <p className="text-sm font-medium text-indigo-400">
          {activeVisitor.name}
        </p>

        <h2 className="mt-2 text-3xl font-bold">
          My Orders
        </h2>

        <p className="mt-3 text-slate-400">
          Your reservations and confirmed bookings.
        </p>
      </div>

      {error && (
        <p role="alert" className="mb-6 text-red-400">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          setError(null);
          void refreshOrders();
        }}
        className="mb-6 rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800"
      >
        Refresh orders
      </button>

      {orders.length === 0 && !error ? (
        <p className="text-slate-400">
          You haven't made any reservations yet.
        </p>
      ) : (
        <div className="space-y-4">

          {orders.map((order) => (
            <article
              key={order.id}
              className="rounded-xl border border-slate-800 bg-slate-900 p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs text-slate-400">
                    Order ID
                  </p>
                  <p className="mt-1 break-all font-mono text-sm">
                    {order.id}
                  </p>
                </div>

                <span className="rounded-full bg-slate-800 px-3 py-1 text-sm">
                  {order.status}
                </span>
              </div>

              <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-sm text-slate-400">
                    {new Date(order.createdAt).toLocaleString('en-GB')}
                  </p>

                  <p className="mt-2 text-xl font-bold">
                    {formatPrice(order.totalCents)}
                  </p>
                </div>

                {order.status === 'PENDING' &&
                	new Date(order.expiresAt).getTime() > now && (
                  <button
                    type="button"
                    disabled={confirmingId !== null}
                    onClick={() => void handleConfirm(order.id)}
                    className="rounded-lg bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {confirmingId === order.id
                      ? 'Confirming...'
                      : 'Confirm booking'}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
