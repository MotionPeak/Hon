import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { queryClient } from './api/queryClient';
import './styles.css';

/**
 * Top-level error boundary so a render-time throw anywhere in the tree shows a
 * recoverable notice instead of white-screening the whole finance UI. Class
 * component because React error boundaries have no hooks equivalent.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{ maxWidth: 480, margin: '15vh auto', padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 18 }}>Something went wrong</h1>
          <p style={{ opacity: 0.8 }}>
            Hon hit an unexpected error. Reloading usually fixes it — your data is
            safe on disk.
          </p>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
