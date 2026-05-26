import type { Loan } from './loans.js';

/** The minimum shape of a transaction the matcher needs. Keeping this
 *  narrow lets the matcher run against either a TxnRow from the repo
 *  or a row mid-insert (where we have fields but not yet an id). */
export interface MatchableTxn {
  description: string;
  amount: number;
}

// הלואה (one vav) is the common abbreviated / bank-printed form of הלוואה.
// Hebrew alternatives use bare substring matching because \b is \w-anchored
// and Hebrew chars are not \w — so \b behaves unexpectedly next to Hebrew.
// Latin alternatives (halvaa, loan) use \b…\b so "loanshark" doesn't trigger.
const STOPWORD_ALTS = 'הלוואה|הלואה|\\b(halvaa|loan)\\b';
const LOAN_STOPWORD = new RegExp(STOPWORD_ALTS, 'iu');
const LOAN_STOPWORD_STRIP = new RegExp(STOPWORD_ALTS, 'giu');

/** Tokens of length ≥3 from a loan name after removing the literal
 *  "הלוואה" / "halvaa" / "loan" stopword. Lowercase Latin; Hebrew
 *  stays as-is (case-insensitivity is moot for Hebrew). */
function nameTokens(name: string): string[] {
  return name
    .replace(LOAN_STOPWORD_STRIP, ' ')
    .split(/[\s\-_.,/\\()]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map((t) => t.toLowerCase());
}

/** Returns the id of the matching loan, or null. Skips positive amounts
 *  (those are income, not payments). Tries externalId hit → name-token
 *  hit → single-loan stopword fallback, in that order. Multi-loan ties
 *  at any rule yield null so the user disambiguates manually. */
export function matchPaymentToLoan(
  txn: MatchableTxn,
  loans: Loan[],
): string | null {
  if (txn.amount >= 0) return null;
  if (loans.length === 0) return null;
  const desc = (txn.description || '').trim();
  if (!desc) return null;
  const descLower = desc.toLowerCase();

  // Rule 1 — externalId hit. Single match wins; multiple is a tie → null.
  const extHits = loans.filter(
    (l) => l.externalId && desc.includes(l.externalId),
  );
  if (extHits.length === 1) return extHits[0]!.id;
  if (extHits.length > 1) return null;

  // Rule 2 — name-token hit. Each loan contributes its tokens; pick the
  // loan whose tokens are uniquely present.
  const tokenHits = loans.filter((l) => {
    const tokens = nameTokens(l.name);
    return tokens.some((t) => descLower.includes(t));
  });
  if (tokenHits.length === 1) return tokenHits[0]!.id;
  if (tokenHits.length > 1) return null;

  // Rule 3 — single-loan stopword fallback. Applies when there is exactly
  // one loan on the connection and the description contains a generic loan
  // keyword (הלוואה / הלואה / loan). However, if the loan's own name
  // contains the stopword (e.g. "הלוואה לרכב"), its sub-terms (e.g. "לרכב")
  // are the real discriminators — a generic stopword description that
  // doesn't match those sub-terms should NOT fall through here.
  if (
    loans.length === 1 &&
    LOAN_STOPWORD.test(desc) &&
    !LOAN_STOPWORD.test(loans[0]!.name)
  ) {
    return loans[0]!.id;
  }

  return null;
}
