import { describe, expect, it } from 'vitest';
import { isPensionLoginUrl } from '../src/pension.js';

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
