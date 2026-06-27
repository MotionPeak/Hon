import { describe, it, expect } from 'vitest';
import { matchesLiveHtzTicket, type HtzTicketState } from '../src/htzTicket.js';

const live: HtzTicketState = { vncTicket: 'good', needsRemoteSignin: true, finished: false };

describe('matchesLiveHtzTicket', () => {
  it('matches a live sync awaiting remote sign-in', () => {
    expect(matchesLiveHtzTicket([live], 'good')).toBe(true);
  });
  it('rejects an empty ticket', () => {
    expect(matchesLiveHtzTicket([live], '')).toBe(false);
  });
  it('rejects a non-matching ticket', () => {
    expect(matchesLiveHtzTicket([live], 'other')).toBe(false);
  });
  it('rejects a finished/cancelled sync (ticket dies with the session)', () => {
    expect(matchesLiveHtzTicket([{ ...live, finished: true }], 'good')).toBe(false);
  });
  it('rejects a sync not awaiting remote sign-in', () => {
    expect(matchesLiveHtzTicket([{ ...live, needsRemoteSignin: false }], 'good')).toBe(false);
  });
  it('scans multiple syncs and matches the live one', () => {
    const states: HtzTicketState[] = [
      { vncTicket: 'a', needsRemoteSignin: true, finished: true },
      { vncTicket: 'b', needsRemoteSignin: true, finished: false },
    ];
    expect(matchesLiveHtzTicket(states, 'b')).toBe(true);
    expect(matchesLiveHtzTicket(states, 'a')).toBe(false);
  });
});
