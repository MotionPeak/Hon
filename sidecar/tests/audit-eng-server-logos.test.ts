import { describe, it, expect } from 'vitest';
import { isPrivateAddress } from '../src/logos.js';

// Backstop for the /logo SSRF fix (M7/M8): isPublicLogoDomain only inspects the
// hostname string, so a public-looking domain whose A/AAAA record resolves
// inward must be caught here, on the RESOLVED address, before any fetch. These
// are the resolved-IP cases assertPublicHost feeds in after DNS lookup.
describe('isPrivateAddress (DNS-rebinding backstop)', () => {
  it('flags IPv4 loopback, link-local, RFC-1918, CGNAT and unspecified', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true); // loopback
    expect(isPrivateAddress('0.0.0.0')).toBe(true); // unspecified
    expect(isPrivateAddress('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateAddress('10.0.0.1')).toBe(true); // 10/8
    expect(isPrivateAddress('192.168.1.1')).toBe(true); // 192.168/16
    expect(isPrivateAddress('172.16.0.1')).toBe(true); // 172.16/12 low edge
    expect(isPrivateAddress('172.31.255.255')).toBe(true); // 172.16/12 high edge
    expect(isPrivateAddress('100.64.0.1')).toBe(true); // CGNAT 100.64/10
  });

  it('allows genuine public IPv4 addresses', () => {
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false); // just above 172.16/12
    expect(isPrivateAddress('172.15.255.255')).toBe(false); // just below 172.16/12
    expect(isPrivateAddress('100.63.255.255')).toBe(false); // just below CGNAT
    expect(isPrivateAddress('100.128.0.0')).toBe(false); // just above CGNAT
    expect(isPrivateAddress('93.184.216.34')).toBe(false); // example.com
  });

  it('flags IPv6 loopback, unspecified, link-local and unique-local', () => {
    expect(isPrivateAddress('::1')).toBe(true); // loopback
    expect(isPrivateAddress('::')).toBe(true); // unspecified
    expect(isPrivateAddress('fe80::1')).toBe(true); // link-local
    expect(isPrivateAddress('febf::1')).toBe(true); // top of fe80::/10
    expect(isPrivateAddress('fc00::1')).toBe(true); // unique-local
    expect(isPrivateAddress('fd12:3456::1')).toBe(true); // unique-local
  });

  it('unwraps IPv4-mapped IPv6 and judges by the embedded IPv4', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows genuine public IPv6 addresses', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false); // Google DNS
  });

  it('fails closed on anything that is not a recognisable IP literal', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
    expect(isPrivateAddress('999.999.999.999')).toBe(true);
  });
});
