import { describe, it, expect, beforeEach } from 'vitest';
import { loadProjectionMode, saveProjectionMode } from './projectionMode';

describe('projectionMode persistence', () => {
  beforeEach(() => window.localStorage.clear());
  it('defaults to committed', () => expect(loadProjectionMode()).toBe('committed'));
  it('round-trips budget', () => { saveProjectionMode('budget'); expect(loadProjectionMode()).toBe('budget'); });
});
