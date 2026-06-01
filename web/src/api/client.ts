// The typed API client core. This re-exports the low-level bearer-token fetch
// (`api`, `ApiError`, `hasToken`) that every per-domain module in this folder
// builds on. Components NO LONGER import `../api` directly — they call the
// domain modules (api/categories, api/loans, …) or the TanStack Query hooks
// layered on top of them, so every endpoint URL + shape lives in exactly one
// place.
//
// Why a thin re-export rather than moving the implementation: the original
// `web/src/api.ts` is imported by a handful of not-yet-migrated spots and has
// its own unit test (`api.test.ts`). Keeping it as the single source of the
// fetch mechanics — and re-exporting here — means the library layer is additive
// and the migration can proceed module by module without a flag day.

export { api, ApiError, hasToken } from '../api';
export type { } from '../api';
