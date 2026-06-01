import { describe, it, expect } from 'vitest';
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  categoryFormSchema,
} from '@hon/shared/category';

// Shared-schema coverage from the web side: confirms the @hon/shared zod
// schemas (the single source of truth shared with the engine) resolve through
// the Vite/Vitest alias and behave as the category form + API library expect.
// NOTE: this file is named `_smoke.test.ts` for historical reasons; it is a
// real, permanent test — consider renaming to `api/categorySchema.test.ts`.
describe('@hon/shared category schemas (web side)', () => {
  it('applies create defaults and trims the name', () => {
    const r = categoryCreateSchema.parse({ name: '  Pets  ' });
    expect(r.name).toBe('Pets');
    expect(r.catGroup).toBe('variable');
    expect(r.color).toBe('#8C8FA8');
    expect(r.emoji).toBe('🏷️');
    expect(r.sortOrder).toBe(100);
  });

  it('rejects a bad hex colour on update', () => {
    expect(categoryUpdateSchema.safeParse({ color: 'nope' }).success).toBe(false);
    expect(categoryUpdateSchema.safeParse({ color: '#5CC773' }).success).toBe(true);
  });

  it('requires a non-empty form name', () => {
    expect(
      categoryFormSchema.safeParse({
        name: '', emoji: '🏷️', color: '#8C8FA8', catGroup: 'variable',
      }).success,
    ).toBe(false);
  });
});
