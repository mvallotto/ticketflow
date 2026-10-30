import { createContext, useContext } from 'react';

export type Visitor = {
  id: string;
  name: string;
};

type VisitorContextValue = {
  visitors: Visitor[];
  activeVisitor: Visitor;
  selectVisitor: (id: string) => void;
  addVisitor: () => void;
};

export const VisitorContext = createContext<VisitorContextValue | null>(null);

export function useVisitor() {
  const context = useContext(VisitorContext);

  if (!context) {
    throw new Error('useVisitor must be used within VisitorProvider');
  }

  return context;
}
