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
    return <p className="text-slate-400">Loading events...</p>;
  }

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-900 bg-red-950/30 p-5 text-red-300">
        {error}
      </div>
    );
  }

  if (events.length === 0) {
    return <p className="text-slate-400">No events available.</p>;
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {events.map((event) => (
        <article
          key={event.id}
          className="flex flex-col rounded-xl border border-slate-800 bg-slate-900 p-6"
        >
          <p className="text-sm font-medium text-indigo-400">
            {formatDate(event.startsAt)}
          </p>

          <h3 className="mt-3 text-xl font-semibold text-white">
            {event.title}
          </h3>

          <p className="mt-2 text-sm text-slate-400">
            {event.location}
          </p>

          <p className="mt-4 flex-1 text-slate-300">
            {event.description}
          </p>

          <button
            type="button"
            onClick={() => onSelectEvent(event.id)}
            className="mt-6 rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white transition hover:bg-indigo-500"
          >
            View tickets
          </button>
        </article>
      ))}
    </div>
  );
}
