# Upstream issue draft — surface loans in `israeli-bank-scrapers`

**Status:** draft, not yet posted.
**Target repo:** [`eshaham/israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers)
**What this is:** Hon's own copy of the GitHub issue to post asking maintainers
to agree on the shape of a `Loan` type before we open a PR. Keep this file
in sync with what we actually post so future-us has the conversation handy.

If maintainers engage, the next step is the PR (move the working scraper code
from `sidecar/src/bankLoans.ts` into the library, add the option flag, ship a
parser test against a sanitized HTML fixture, update the README).

---

**Title:** `Proposal: surface loans alongside transactions (starting with FIBI/Beinleumi-group)`

**Body:**

## Summary

The library normalizes accounts with `balance` and `txns`, but most Israeli banking portals also expose a loans area (mortgage tracks, prime/CPI-linked, personal loans) behind the same authenticated session. Consumers building finance aggregators currently have to re-scrape it themselves. Proposing a small, opt-in addition to surface it through the library.

This issue is about the **shape and naming** — the implementation is straightforward; I have a working version against FIBI/Beinleumi-group. Looking for maintainer guidance before I open a PR.

## Proposed type

```ts
// lib/scrapers/loans.ts (or add to lib/transactions.ts)
export interface Loan {
  /** Bank-side stable id (e.g. FIBI shows "108-416" beneath the loan name). */
  externalId: string;
  /** Display name as the bank shows it (e.g. "דיגיטל"). */
  name: string;
  /** Original principal in `currency`. */
  principal: number;
  /** Loan-start date, YYYY-MM-DD. */
  startDate: string;
  /** Total length in months, derived from start → final-payment date. */
  termMonths: number;
  /** Prime + margin track (rate quoted as "P+X.XX"). */
  isPrime: boolean;
  /** Principal scales with the consumer price index ("צמוד למדד"). */
  isCpiLinked: boolean;
  /** Annual %: the fixed rate, or the margin over prime when isPrime. */
  rateValue: number;
  currency: string;
  /** Bank-reported outstanding (lets consumers cross-check their own math). */
  currentDebt?: number;
  /** Bank-reported next monthly payment. */
  nextPayment?: number;
}
```

## Opt-in option

```ts
// ScraperOptions
scrapeLoans?: boolean; // default false — extra navigation, not all consumers need it
```

## Where the field lives

Two reasonable options — I lean **top-level on `ScraperScrapingResult`**, because at FIBI the loans page is not per-account:

```ts
interface ScraperScrapingResult {
  success: boolean;
  accounts?: TransactionsAccount[];
  loans?: Loan[];   // ← new
  errorType?: ErrorTypes;
  errorMessage?: string;
}
```

Per-account would also work but requires deciding which account a multi-product loan belongs to, which the FIBI portal doesn't volunteer.

## Implementation sketch (FIBI/Beinleumi-group)

The loans page lives in the legacy `wps` iframe inside the new shell, anchored on the Hebrew header `שם ההלוואה`:

```ts
const FIBI_LOANS_URL =
  'https://online.fibi.co.il/appsng/Resources/PortalNG/shell/' +
  '#/Online/OnLoansMortgageMenu/OnLoans/AuthLoansDetails';
const FIBI_LOAN_HEADER_HE = 'שם ההלוואה';

async function scrapeFibiLoans(browser: Browser): Promise<Loan[]> {
  const page = await browser.newPage();
  try {
    await page.goto(FIBI_LOANS_URL, { waitUntil: 'domcontentloaded' });
    const target = await waitForLoansAnchor(page, 45_000);
    if (!target) return [];
    const rows = await extractRows(target);
    return rows.map(parseRow).filter(Boolean) as Loan[];
  } finally {
    await page.close().catch(() => {});
  }
}
```

Rate parsing recognises `P+X.XX %`, plain `X.XX %`, the `צמוד` prefix for CPI-linked tracks, and discards the parenthesised effective-rate that FIBI prints alongside the formula. Term is derived from the start → final-payment date columns. Tested live against a Beinleumi personal-loan ("דיגיטל") track.

## Questions before I open a PR

1. **Field placement** — top-level `loans` on `ScraperScrapingResult` OK, or per-account on `TransactionsAccount`?
2. **Option name** — `scrapeLoans` works; would you prefer `fetchLoans` (matches `fetchTransactions`)?
3. **Test fixture** — happy to ship a sanitized HTML snapshot of the loans page + a parser unit test. Preferred location (`tests/fixtures/beinleumi-loans.html`)?
4. **Other banks** — I've only verified FIBI/Beinleumi-group. Hapoalim/Leumi/Discount would need parallel work; happy to start with FIBI and let others extend the same `Loan` shape per scraper.

Happy to follow up with a PR once we agree on the shape.

---

## Notes for the Hon side (don't paste into the GitHub issue)

- Full working implementation lives at `sidecar/src/bankLoans.ts`. The issue
  ships a slimmed sketch; the PR (once approved in shape) lifts the real code.
- The actual production code dumps debug HTML on the failure path and logs
  via `console.error('[bank-loans] …')`. Both come out for upstream — the
  library uses `debug()`.
- The "company id → loans page applies" check (`supportsBankLoans`) covers
  `beinleumi`, `otsarHahayal`, `massad`, `pagi`. They share the FIBI portal.
- If maintainers want a separate PR for the existing un-upstreamed Hon
  patches (FIBI amount parser handles Unicode directional marks + trailing
  minus): worth offering. Reference + balance patches are opinionated
  changes (one breaks the `identifier: number` contract; the others fill a
  null `balance`) — better kept Hon-local unless explicitly asked for.
