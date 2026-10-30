import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { VisitorProvider } from './contexts/VisitorContext';

import './styles/tailwind.css';
import './styles/main.less';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <VisitorProvider>
      <App />
    </VisitorProvider>
  </StrictMode>,
);
