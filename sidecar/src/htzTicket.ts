/** Minimal shape of a Hi-Tech Zone voucher sync for the /vnc ticket check —
 *  kept here (not on the server module) so the security predicate is unit
 *  testable in isolation. Mirrors the live-only semantics of
 *  `ScrapeRunner.validateVncTicket`. */
export interface HtzTicketState {
  vncTicket?: string;
  needsRemoteSignin?: boolean;
  finished?: boolean;
}

/**
 * True when `ticket` matches a Hi-Tech Zone sync that is STILL awaiting remote
 * sign-in — so its noVNC window is reachable only while the captcha is actually
 * pending. A finished or cancelled sync sets `finished`, which kills the ticket;
 * an empty ticket never matches. This is what gates the token-protected /vnc
 * proxy for the voucher flow.
 */
export function matchesLiveHtzTicket(
  states: Iterable<HtzTicketState>,
  ticket: string,
): boolean {
  if (!ticket) return false;
  for (const s of states) {
    if (s.vncTicket === ticket && s.needsRemoteSignin === true && !s.finished) {
      return true;
    }
  }
  return false;
}
