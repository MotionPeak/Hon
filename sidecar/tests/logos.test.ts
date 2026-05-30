import { describe, it, expect } from 'vitest';
import { isSafeCompanyId, isPublicLogoDomain } from '../src/logos.js';

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

describe('isPublicLogoDomain', () => {
  it('accepts real brand hostnames with an alpha TLD', () => {
    expect(isPublicLogoDomain('interactivebrokers.ca')).toBe(true);
    expect(isPublicLogoDomain('max.co.il')).toBe(true);
    expect(isPublicLogoDomain('bankhapoalim.co.il')).toBe(true);
    expect(isPublicLogoDomain('www.leumi.co.il')).toBe(true);
  });

  // SSRF guard (H-1): raw IPs, link-local, and RFC-1918 ranges must be rejected
  // even though the caller's hostname regex would let them through.
  it('rejects raw IPv4 / link-local / loopback addresses', () => {
    expect(isPublicLogoDomain('127.0.0.1')).toBe(false);
    expect(isPublicLogoDomain('169.254.169.254')).toBe(false);
    expect(isPublicLogoDomain('192.168.1.1')).toBe(false);
    expect(isPublicLogoDomain('10.0.0.1')).toBe(false);
    expect(isPublicLogoDomain('172.16.0.1')).toBe(false);
    expect(isPublicLogoDomain('1.2.3.4')).toBe(false);
  });

  it('rejects loopback / mDNS names', () => {
    expect(isPublicLogoDomain('localhost')).toBe(false);
    expect(isPublicLogoDomain('foo.local')).toBe(false);
    expect(isPublicLogoDomain('printer.localdomain')).toBe(false);
    expect(isPublicLogoDomain('app.localhost')).toBe(false);
  });

  it('rejects empty / numeric-TLD junk', () => {
    expect(isPublicLogoDomain('')).toBe(false);
    expect(isPublicLogoDomain('host.123')).toBe(false);
  });
});
