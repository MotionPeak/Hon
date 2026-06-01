import type { ReactElement, ReactNode } from 'react';
import { render as rtlRender, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Test render helper that wraps the UI in a fresh QueryClientProvider — the
// real app provides one in main.tsx, so any component using TanStack Query
// hooks (useCategories, etc.) needs it under test too. A NEW client per render
// keeps tests isolated (no cache bleed between cases); retry:false + gcTime:0
// make loading/error assertions deterministic.
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  const client = makeTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, ...rtlRender(ui, { wrapper: Wrapper, ...options }) };
}
