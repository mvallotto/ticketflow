import type { ReactNode } from 'react';
import { VisitorSwitcher } from './VisitorSwitcher';

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">
            TicketFlow
          </h1>

          <VisitorSwitcher />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {children}
      </main>
    </div>
  );
}
