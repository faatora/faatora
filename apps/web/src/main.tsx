// Sentry MUST be initialised before React renders so that error
// boundaries catch render errors from the first frame and so that
// browserTracing can instrument fetch/history. Keep this at the top.
import { initSentry, Sentry } from './lib/sentry';
initSentry();

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorFallback } from './components/ErrorFallback';
import './i18n';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={ErrorFallback}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
