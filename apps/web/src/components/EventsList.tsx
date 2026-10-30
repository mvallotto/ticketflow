import { useEffect, useState } from 'react';
import { getEvents } from '../lib/api';
import type { Event } from '../types/event';

type EventsListProps = {
  onSelectEvent: (eventId: string) => void;
};

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Amsterdam',
  }).format(new Date(date));
}

export function EventsList({ onSelectEvent }: EventsListProps) {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadEvents() {
      try {
        setLoading(true);
        setError(null);

        const data = await getEvents(controller.signal);
        setEvents(data);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : 'Unable to load events',
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadEvents();

    return () => controller.abort();
  }, []);

  if (loading) {
    return <p className="message">Loading events...</p>;
  }

  if (error) {
    return (
      <div role="alert" className="error-notice">
        {error}
      </div>
    );
  }

  if (events.length === 0) {
    return <p className="message">No events available.</p>;
  }

  return (
    <div className="events-grid">
      {events.map((event) => (
        <article
          key={event.id}
          className="event-card"
        >
          <p className="view-eyebrow">
            {formatDate(event.startsAt)}
          </p>

          <h3 className="event-card__title">
            {event.title}
          </h3>

          <p className="event-card__location">
            {event.location}
          </p>

          <p className="event-card__description">
            {event.description}
          </p>

          <button
            type="button"
            onClick={() => onSelectEvent(event.id)}
            className="button button--primary event-card__action"
          >
            View tickets
          </button>
        </article>
      ))}
    </div>
  );
}
