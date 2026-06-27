import { describe, it, expect } from 'vitest';
import { txnDetailsSchema } from '../../shared/transaction.js';

describe('txnDetailsSchema', () => {
  it('accepts title + notes, nulls, and omitted fields', () => {
    expect(txnDetailsSchema.safeParse({ customTitle: 'Hi', notes: 'n' }).success).toBe(true);
    expect(txnDetailsSchema.safeParse({ customTitle: null }).success).toBe(true);
    expect(txnDetailsSchema.safeParse({}).success).toBe(true);
  });
  it('rejects an over-long title or notes', () => {
    expect(txnDetailsSchema.safeParse({ customTitle: 'x'.repeat(201) }).success).toBe(false);
    expect(txnDetailsSchema.safeParse({ notes: 'x'.repeat(2001) }).success).toBe(false);
  });
});
