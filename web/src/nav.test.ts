import { describe, expect, it } from 'vitest';
import { TABS } from './nav';

describe('nav model', () => {
  it('lists the 9 top-level sections with unique ids', () => {
    expect(TABS).toHaveLength(9);
    const ids = TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(9);
    expect(ids).toContain('overview');
    expect(ids).toContain('settings');
  });

  it('gives every tab a label and an emoji', () => {
    for (const t of TABS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.emoji.length).toBeGreaterThan(0);
    }
  });
});
