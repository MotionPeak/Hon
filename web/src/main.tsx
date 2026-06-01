import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { queryClient } from './api/queryClient';
import './styles.css';

// Hon's React entry. The actual app lives in App.tsx; this file's only
// job is to mount and render. The token from the URL fragment is read
// inside <App> so any Suspense / error boundary added later can sit
// above it without re-implementing the bootstrap.
//
// QueryClientProvider wraps the app so every component can use TanStack Query
// hooks for server state (the `useQuery`/`useMutation` hooks under api/hooks).
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found in index.html');
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
