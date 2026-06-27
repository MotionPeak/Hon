import { describe, it, expect } from 'vitest';
import { displayName } from './displayName';

describe('displayName', () => {
  it('uses the custom title when set', () => {
    expect(displayName({ customTitle: 'Lunch', description: 'SHUFERSAL' })).toBe('Lunch');
  });
  it('falls back to description when title is empty/whitespace/null', () => {
    expect(displayName({ customTitle: '   ', description: 'SHUFERSAL' })).toBe('SHUFERSAL');
    expect(displayName({ customTitle: null, description: 'SHUFERSAL' })).toBe('SHUFERSAL');
    expect(displayName({ description: 'SHUFERSAL' })).toBe('SHUFERSAL');
  });
});
