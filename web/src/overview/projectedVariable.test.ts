import { describe, it, expect } from 'vitest';
import { projectVariable, type VariableInput } from './projectedVariable';

const base: VariableInput = {
  income: 10000, spent: 1500, essentialSpent: 800,
  fixedSpent: 3000, piggyFunded: 0, savings: 0,
};

describe('projectVariable', () => {
  it('reserves predicted fixed + essential budget and nets out spend', () => {
    // essential budget 2000 > spent 800 → reserve 2000; fixed predicted 3500.
    const r = projectVariable(base, 2000, 3500);
    expect(r.fixed).toBe(3500);
    expect(r.essential).toBe(2000);
    expect(r.committed).toBe(5500);
    expect(r.disposable).toBe(10000 - 5500); // 4500
    expect(r.allowed).toBe(4500 - 1500); // 3000
    expect(r.projected).toBe(true);
  });

  it('falls back to posted fixedSpent when no projection, dropping projected', () => {
    const r = projectVariable(base, 0, null);
    expect(r.fixed).toBe(3000); // posted
    expect(r.essential).toBe(800); // no budget → use spent
    expect(r.projected).toBe(false);
  });

  it('subtracts piggy set-asides and savings from the leftover', () => {
    const r = projectVariable(
      { ...base, piggyFunded: 500, savings: 700 }, 2000, 3500,
    );
    expect(r.piggy).toBe(500);
    expect(r.savings).toBe(700);
    expect(r.disposable).toBe(10000 - 5500 - 500 - 700); // 3300
    expect(r.allowed).toBe(3300 - 1500); // 1800
  });

  it('goes negative when commitments outrun income', () => {
    const r = projectVariable(
      { income: 4000, spent: 0, essentialSpent: 0, fixedSpent: 0, piggyFunded: 0, savings: 0 },
      2000, 3500,
    );
    expect(r.disposable).toBe(4000 - 5500); // -1500
    expect(r.allowed).toBeLessThan(0);
  });
});
