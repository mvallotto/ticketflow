import type { ReactNode } from 'react';
import { VisitorSwitcher } from './VisitorSwitcher';

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-header__content">
          <h1 className="app-header__title">
            TicketFlow
          </h1>

          <VisitorSwitcher />
        </div>
      </header>

      <main className="app-main">
        {children}
      </main>
    </div>
  );
}
