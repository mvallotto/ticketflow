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
      <nav className="navigation">
        <button
          type="button"
          onClick={() => {
            setCurrentPage('events');
            backToEvents();
          }}
          className="navigation__link"
          aria-current={currentPage === 'events' ? 'page' : undefined}
        >
          Events
        </button>

        <button
          type="button"
          onClick={() => setCurrentPage('orders')}
          className="navigation__link"
          aria-current={currentPage === 'orders' ? 'page' : undefined}
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
          <div className="view-heading">
            <p className="view-eyebrow">
              Welcome, {activeVisitor.name}
            </p>

            <h2 className="view-heading__title">
              Discover events
            </h2>

            <p className="view-description">
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
