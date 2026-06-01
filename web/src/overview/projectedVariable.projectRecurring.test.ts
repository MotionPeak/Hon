import { describe, it, expect } from 'vitest';
import { projectVariable, type VariableInput } from './projectedVariable';

// Covers the M14 fix: the `projectRecurring` master switch must override any
// detected recurring history. When off, the allowance reserves only the posted
// `fixedSpent` (not the predicted figure) and drops the "Projected — …" note.
const base: VariableInput = {
  income: 10000, spent: 1500, essentialSpent: 800,
  fixedSpent: 3000, piggyFunded: 0, savings: 0,
};

describe('projectVariable — projectRecurring gate', () => {
  it('defaults to projecting (flag omitted)', () => {
    const r = projectVariable(base, 2000, 3500);
    expect(r.fixed).toBe(3500);
    expect(r.projected).toBe(true);
  });

  it('still projects when the flag is explicitly true', () => {
    const r = projectVariable(base, 2000, 3500, true);
    expect(r.fixed).toBe(3500);
    expect(r.projected).toBe(true);
  });

  it('falls back to posted fixedSpent and drops projected when the flag is false', () => {
    // predictedFixed (3500) is present but the master switch is off, so the
    // posted 3000 is reserved instead and the card shows no projection note.
    const r = projectVariable(base, 2000, 3500, false);
    expect(r.fixed).toBe(3000);
    expect(r.essential).toBe(2000);
    expect(r.committed).toBe(5000);
    expect(r.disposable).toBe(10000 - 5000); // 5000
    expect(r.allowed).toBe(5000 - 1500); // 3500
    expect(r.projected).toBe(false);
  });

  it('stays non-projected when the flag is false and there is no predicted figure', () => {
    const r = projectVariable(base, 0, null, false);
    expect(r.fixed).toBe(3000); // posted
    expect(r.projected).toBe(false);
  });
});
