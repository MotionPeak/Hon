import { describe, expect, it } from 'vitest';
import { isPensionLoginUrl, parseHerkevNehasim } from '../src/pension.js';

// Table-driven coverage of every pension fund's login URL Hon supports,
// plus a handful of post-login dashboard URLs that MUST NOT match. The
// 2026-05-25 regression that re-introduced the "page keeps refreshing
// while I sign in" bug for Menora users would have been caught by this
// test before deploy: the previous regex `[\/#](v\d+\/)?(login|...)\b`
// rejected `customer-login/` because `\b` between a hyphen and a letter
// is NOT a word boundary in the regex engine's view.
describe('isPensionLoginUrl', () => {
  describe('matches login URLs', () => {
    const matchCases: [string, string][] = [
      ['Meitav loginAmit',
        'https://customers.meitav.co.il/v2/login/loginAmit'],
      ['Menora customer-login (the 2026-05-25 regression case)',
        'https://www.menoramivt.co.il/customer-login/'],
      ['Generic /Login/ segment',
        'https://www.menoramivt.co.il/Login/'],
      ['Hyphenated prefix variant',
        'https://example.com/member-signin'],
      ['Plain /auth/callback',
        'https://example.com/auth/callback'],
      ['Plain /otp',
        'https://example.com/otp'],
      ['Plain /verify',
        'https://example.com/v3/verify'],
      ['Hash-routed login',
        'https://example.com/dashboard#/login'],
      ['Hash-bang-routed signin',
        'https://example.com/dashboard#!/sign-in'],
      ['Case-insensitive match',
        'https://example.com/LOGIN'],
    ];
    for (const [name, url] of matchCases) {
      it(name, () => expect(isPensionLoginUrl(url)).toBe(true));
    }
  });

  describe('does NOT match post-login / unrelated URLs', () => {
    const rejectCases: [string, string][] = [
      ['Meitav dashboard',
        'https://customers.meitav.co.il/lobbymanager'],
      ['Harel dashboard',
        'https://digital.harel-group.co.il/personal-area'],
      ['Menora dashboard',
        'https://www.menoramivt.co.il/dashboard'],
      ['Plain home page',
        'https://example.com/'],
      ['News article that happens to have no login segment',
        'https://example.com/articles/12345'],
      ['Empty string',
        ''],
    ];
    for (const [name, url] of rejectCases) {
      it(name, () => expect(isPensionLoginUrl(url)).toBe(false));
    }
  });
});

// parseHerkevNehasim is the trust boundary for Meitav's
// GetCalculatedHerkevNehasim response — a scraped, untyped JSON blob. These
// cases lock CURRENT behavior exactly (faithful refactor): which rows survive,
// which are dropped, and the precise shape of each emitted holding. A naive
// z.number()/z.coerce.number() would break several of them — pinning them is
// the whole point.
describe('parseHerkevNehasim', () => {
  it('groups valid rows by MisparTik, trims descriptions, rounds value to 2dp', () => {
    const body = [
      { MisparTik: 100, MisparNiar: 5113022, TeurNiar: '  תל בונד 20  ', Shovi: 12345.678 },
      { MisparTik: 100, MisparNiar: 1159250, TeurNiar: 'מק"מ', Shovi: 5000 },
      { MisparTik: 200, MisparNiar: 691212, TeurNiar: 'S&P 500', Shovi: 9999.5 },
    ];
    const result = parseHerkevNehasim(body);
    expect([...result.keys()]).toEqual(['100', '200']);
    expect(result.get('100')).toEqual([
      { symbol: '5113022', description: 'תל בונד 20', units: 0, value: 12345.68, currency: 'ILS' },
      { symbol: '1159250', description: 'מק"מ', units: 0, value: 5000, currency: 'ILS' },
    ]);
    expect(result.get('200')).toEqual([
      { symbol: '691212', description: 'S&P 500', units: 0, value: 9999.5, currency: 'ILS' },
    ]);
  });

  it('accepts the { t: [...] } envelope shape identically to a bare array', () => {
    const rows = [{ MisparTik: 1, MisparNiar: 42, TeurNiar: 'x', Shovi: 10 }];
    const expected = [{ symbol: '42', description: 'x', units: 0, value: 10, currency: 'ILS' }];
    expect(parseHerkevNehasim(rows).get('1')).toEqual(expected);
    expect(parseHerkevNehasim({ t: rows }).get('1')).toEqual(expected);
  });

  it('returns an empty map for bodies that are neither an array nor { t: array }', () => {
    for (const body of [null, undefined, 42, 'nope', {}, { t: 'notarray' }, { x: [] }]) {
      expect(parseHerkevNehasim(body).size).toBe(0);
    }
  });

  it('isolates bad rows — one unparseable row never drops its neighbours', () => {
    const body = [
      { MisparTik: 1, MisparNiar: 10, TeurNiar: 'good', Shovi: 100 },
      { MisparTik: 1, MisparNiar: 11, TeurNiar: 'bad value', Shovi: 'not-a-number' },
      { MisparTik: 1, MisparNiar: 12, TeurNiar: 'missing shovi' },
      { MisparTik: 1, MisparNiar: 13, TeurNiar: 'also good', Shovi: 50 },
    ];
    expect(parseHerkevNehasim(body).get('1')).toEqual([
      { symbol: '10', description: 'good', units: 0, value: 100, currency: 'ILS' },
      { symbol: '13', description: 'also good', units: 0, value: 50, currency: 'ILS' },
    ]);
  });

  it('drops rows whose Shovi is non-finite (NaN string, missing)', () => {
    const body = [
      { MisparTik: 1, MisparNiar: 10, TeurNiar: 'nan', Shovi: 'abc' },
      { MisparTik: 1, MisparNiar: 11, TeurNiar: 'undef' },
    ];
    expect(parseHerkevNehasim(body).size).toBe(0);
  });

  it('keeps a row whose Shovi coerces to a finite number (null → 0, "5000" → 5000)', () => {
    const body = [
      { MisparTik: 1, MisparNiar: 10, TeurNiar: 'null shovi', Shovi: null },
      { MisparTik: 2, MisparNiar: 11, TeurNiar: 'string shovi', Shovi: '5000' },
    ];
    expect(parseHerkevNehasim(body).get('1')).toEqual([
      { symbol: '10', description: 'null shovi', units: 0, value: 0, currency: 'ILS' },
    ]);
    expect(parseHerkevNehasim(body).get('2')).toEqual([
      { symbol: '11', description: 'string shovi', units: 0, value: 5000, currency: 'ILS' },
    ]);
  });

  it('drops comma-formatted Shovi strings (known gap — Number("1,234.56") is NaN)', () => {
    // Documented limitation of the faithful refactor: thousands-separated
    // values are dropped today. Lifting this is the deferred "harden number
    // parsing" follow-up, not part of this change.
    const body = [{ MisparTik: 1, MisparNiar: 10, TeurNiar: 'comma', Shovi: '1,234.56' }];
    expect(parseHerkevNehasim(body).size).toBe(0);
  });

  it('drops rows with neither MisparNiar nor TeurNiar, even with a finite Shovi', () => {
    const body = [
      { MisparTik: 1, MisparNiar: null, TeurNiar: '   ', Shovi: 999 },
      { MisparTik: 1, MisparNiar: null, TeurNiar: null, Shovi: 999 },
    ];
    expect(parseHerkevNehasim(body).size).toBe(0);
  });

  it('falls back to the description for symbol when MisparNiar is absent', () => {
    const body = [{ MisparTik: 1, MisparNiar: null, TeurNiar: 'Cash ILS', Shovi: 250 }];
    expect(parseHerkevNehasim(body).get('1')).toEqual([
      { symbol: 'Cash ILS', description: 'Cash ILS', units: 0, value: 250, currency: 'ILS' },
    ]);
  });

  it('leaves description undefined when TeurNiar is empty/whitespace', () => {
    const body = [{ MisparTik: 1, MisparNiar: 77, TeurNiar: '   ', Shovi: 250 }];
    const list = parseHerkevNehasim(body).get('1')!;
    expect(list[0].symbol).toBe('77');
    expect(list[0].description).toBeUndefined();
  });

  it('groups rows with a null/absent MisparTik under the empty-string key', () => {
    const body = [{ MisparNiar: 77, TeurNiar: 'no tik', Shovi: 250 }];
    expect(parseHerkevNehasim(body).get('')).toEqual([
      { symbol: '77', description: 'no tik', units: 0, value: 250, currency: 'ILS' },
    ]);
  });
});
