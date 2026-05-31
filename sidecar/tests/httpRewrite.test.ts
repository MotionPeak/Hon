// sidecar/tests/httpRewrite.test.ts
import { describe, expect, it } from 'vitest';
import { rewriteApiPrefix } from '../src/httpRewrite.js';

describe('rewriteApiPrefix', () => {
  it('strips a leading /api segment', () => {
    expect(rewriteApiPrefix('/api/loans')).toBe('/loans');
    expect(rewriteApiPrefix('/api/connections/123/scrape')).toBe('/connections/123/scrape');
    expect(rewriteApiPrefix('/api/summary?x=1')).toBe('/summary?x=1');
  });
  it('maps bare /api to /', () => {
    expect(rewriteApiPrefix('/api')).toBe('/');
    expect(rewriteApiPrefix('/api/')).toBe('/');
  });
  it('leaves non-/api paths untouched', () => {
    expect(rewriteApiPrefix('/')).toBe('/');
    expect(rewriteApiPrefix('/assets/index-abc.js')).toBe('/assets/index-abc.js');
    expect(rewriteApiPrefix('/logo/hapoalim')).toBe('/logo/hapoalim');
    expect(rewriteApiPrefix('/loans')).toBe('/loans');
  });
  it('does not strip a partial match (/apiary)', () => {
    expect(rewriteApiPrefix('/apiary')).toBe('/apiary');
    expect(rewriteApiPrefix('/api-keys')).toBe('/api-keys');
  });
});
