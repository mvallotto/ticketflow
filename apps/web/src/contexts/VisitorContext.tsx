import {
  useState,
  type ReactNode,
} from 'react';
import { VisitorContext, type Visitor } from './useVisitor';

const STORAGE_KEY = 'ticketflow:visitors';
const ACTIVE_STORAGE_KEY = 'ticketflow:activeVisitor';

function createVisitor(index: number): Visitor {
  return {
    id: crypto.randomUUID(),
    name: `Visitor ${String.fromCharCode(65 + index)}`,
  };
}

function loadVisitors(): Visitor[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);

    if (stored) {
      const parsed: unknown = JSON.parse(stored);

      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (visitor) =>
            typeof visitor === 'object' &&
            visitor !== null &&
            typeof visitor.id === 'string' &&
            typeof visitor.name === 'string',
        )
      ) {
        return parsed as Visitor[];
      }
    }
  } catch {
    // Fall back to a default visitor.
  }

  const initialVisitors = [createVisitor(0)];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initialVisitors));

  return initialVisitors;
}

export function VisitorProvider({ children }: { children: ReactNode }) {
  const [visitors, setVisitors] = useState<Visitor[]>(loadVisitors);

  const [activeVisitorId, setActiveVisitorId] = useState<string>(() => {
    return localStorage.getItem(ACTIVE_STORAGE_KEY) ?? '';
  });

  const activeVisitor =
    visitors.find((visitor) => visitor.id === activeVisitorId) ??
    visitors[0];

  function selectVisitor(id: string) {
    if (!visitors.some((visitor) => visitor.id === id)) {
      return;
    }

    setActiveVisitorId(id);
    localStorage.setItem(ACTIVE_STORAGE_KEY, id);
  }

  function addVisitor() {
    const visitor = createVisitor(visitors.length);

    const updatedVisitors = [...visitors, visitor];

    setVisitors(updatedVisitors);
    setActiveVisitorId(visitor.id);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedVisitors));
    localStorage.setItem(ACTIVE_STORAGE_KEY, visitor.id);
  }

  return (
    <VisitorContext.Provider
      value={{
        visitors,
        activeVisitor,
        selectVisitor,
        addVisitor,
      }}
    >
      {children}
    </VisitorContext.Provider>
  );
}
