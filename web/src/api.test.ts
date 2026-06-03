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

describe('token persistence (PWA standalone launch)', () => {
  it('reads the token from the URL fragment and persists it', () => {
    window.location.hash = 'token=abc-123';
    expect(hasToken()).toBe(true);
    expect(window.localStorage.getItem('hon.token')).toBe('abc-123');
  });

  it('falls back to the persisted token when the fragment is empty', () => {
    window.localStorage.setItem('hon.token', 'persisted-xyz');
    window.location.hash = '';
    expect(hasToken()).toBe(true);
  });

  it('is false when neither fragment nor storage has a token', () => {
    window.location.hash = '';
    expect(hasToken()).toBe(false);
  });
});
