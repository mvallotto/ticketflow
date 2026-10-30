import { useState } from 'react';
import { AppLayout } from './components/AppLayout';
import { EventsList } from './components/EventsList';
import { EventDetail } from './components/EventDetail';
import { OrderConfirmation } from './components/OrderConfirmation';
import { MyOrders } from './components/MyOrders';
import { useVisitor } from './contexts/useVisitor';
import type { CreatedOrder } from './lib/api';

function App() {
  const { activeVisitor } = useVisitor();

  const [currentPage, setCurrentPage] = useState<'events' | 'orders'>('events');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [createdOrder, setCreatedOrder] = useState<CreatedOrder | null>(null);

  function backToEvents() {
    setCreatedOrder(null);
    setSelectedEventId(null);
  }

  return (
    <AppLayout>
      <nav className="mb-8 flex gap-4 border-b border-slate-800 pb-4">
        <button
          type="button"
          onClick={() => {
            setCurrentPage('events');
            backToEvents();
          }}
          className={
            currentPage === 'events'
              ? 'font-semibold text-indigo-400'
              : 'text-slate-400 hover:text-white'
          }
        >
          Events
        </button>

        <button
          type="button"
          onClick={() => setCurrentPage('orders')}
          className={
            currentPage === 'orders'
              ? 'font-semibold text-indigo-400'
              : 'text-slate-400 hover:text-white'
          }
        >
          My Orders
        </button>
      </nav>

      {currentPage === 'orders' ? (
        <MyOrders />
      ) : createdOrder ? (
        <OrderConfirmation
          order={createdOrder}
          onBack={backToEvents}
        />
      ) : selectedEventId ? (
        <EventDetail
          eventId={selectedEventId}
          onBack={backToEvents}
          onOrderCreated={setCreatedOrder}
        />
      ) : (
        <>
          <div className="mb-8">
            <p className="text-sm font-medium text-indigo-400">
              Welcome, {activeVisitor.name}
            </p>

            <h2 className="mt-2 text-3xl font-bold">
              Discover events
            </h2>

            <p className="mt-3 text-slate-400">
              Explore upcoming events and reserve your tickets.
            </p>
          </div>

          <EventsList onSelectEvent={setSelectedEventId} />
        </>
      )}
    </AppLayout>
  );
}

export default App;
