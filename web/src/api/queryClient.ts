// The app-wide TanStack Query client + the central query-key registry.
//
// Query keys live here (not scattered as inline arrays) so invalidation is
// type-safe and greppable: a mutation that changes categories calls
// `queryClient.invalidateQueries({ queryKey: qk.categories() })` and every
// component subscribed to that key refetches. Server state is owned entirely by
// Query (caching, dedupe, background refetch, loading/error) — replacing the
// old useEffect+useState+api() fetch-then-setState pattern.

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Hon talks to a loopback engine, so network cost is ~0, but the data
      // (transactions, budgets) changes only on user action or a sync. A short
      // staleTime avoids refetch storms when several cards mount at once while
      // still picking up changes promptly.
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/** Central query-key factory. Each domain returns a stable tuple; pass an id
 *  for entity-scoped keys. Keep these in sync with the api/ modules. */
export const qk = {
  health: () => ['health'] as const,
  categories: () => ['categories'] as const,
  connections: () => ['connections'] as const,
  accounts: () => ['accounts'] as const,
  transactions: () => ['transactions'] as const,
  loans: () => ['loans'] as const,
  assets: () => ['assets'] as const,
  vouchers: () => ['vouchers'] as const,
  summary: () => ['summary'] as const,
  budget: (params?: string) => (params ? (['budget', params] as const) : (['budget'] as const)),
  merchantFrequencies: () => ['merchant-frequencies'] as const,
  categorySplits: () => ['category-splits'] as const,
  cancelledSubs: () => ['subscriptions', 'cancelled'] as const,
} as const;
