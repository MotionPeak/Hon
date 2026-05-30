import { describe, it, expect } from 'vitest';
import { isSafeCompanyId } from '../src/logos.js';

describe('isSafeCompanyId', () => {
  it('accepts normal bank ids', () => {
    expect(isSafeCompanyId('hapoalim')).toBe(true);
    expect(isSafeCompanyId('visaCal')).toBe(true);
    expect(isSafeCompanyId('a_b-1')).toBe(true);
  });

  // Brokerage and voucher logo cache keys are built as `brk-<domain>` /
  // `voucher-<id>` and therefore legitimately contain dots and hyphens.
  it('accepts brokerage/voucher ids with dots', () => {
    expect(isSafeCompanyId('brk-interactivebrokers.ca')).toBe(true);
    expect(isSafeCompanyId('brk-alpaca.markets')).toBe(true);
    expect(isSafeCompanyId('voucher-htz')).toBe(true);
    expect(isSafeCompanyId('voucher-buyme')).toBe(true);
  });

  it('rejects path traversal', () => {
    expect(isSafeCompanyId('../../etc/passwd')).toBe(false);
    expect(isSafeCompanyId('..%2F..%2Ffoo')).toBe(false);
    expect(isSafeCompanyId('a/b')).toBe(false);
    expect(isSafeCompanyId('a\\b')).toBe(false);
    // No bare ".." segments even without a slash — blocks "..", "a..b" stays safe
    // only because there is no separator, but a leading/trailing dot-dot escape
    // attempt like "..foo" or "foo.." must be rejected to be conservative.
    expect(isSafeCompanyId('..')).toBe(false);
    expect(isSafeCompanyId('a..b')).toBe(false);
  });

  it('rejects empty', () => {
    expect(isSafeCompanyId('')).toBe(false);
  });

  it('rejects too long', () => {
    expect(isSafeCompanyId('a'.repeat(61))).toBe(false);
  });
});
