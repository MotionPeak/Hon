import { describe, expect, it } from 'vitest';
import { hasToken } from './api';

describe('hasToken', () => {
  it('returns false when no token is in the URL fragment', () => {
    window.location.hash = '';
    expect(hasToken()).toBe(false);
  });

  it('returns true when token=… is in the URL fragment', () => {
    window.location.hash = 'token=abc';
    expect(hasToken()).toBe(true);
  });

  it('reflects hash changes after module load (not a frozen snapshot)', () => {
    window.location.hash = '';
    expect(hasToken()).toBe(false);
    window.location.hash = 'token=later';
    expect(hasToken()).toBe(true);
  });
});
