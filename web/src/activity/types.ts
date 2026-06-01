// Transaction is defined as a shared zod schema (single source of truth for
// the engine + web; see shared/transaction.ts). Re-exported here so existing
// `import { Transaction } from '../activity/types'` sites keep working.

export type { Transaction } from '@hon/shared/transaction';
