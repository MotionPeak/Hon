import { describe, it, expect } from 'vitest';
import { isSafeKeyTarget } from '../src/llm.js';

// Guard for the low-sev key-exfiltration / SSRF item: the stored API key may
// only be sent as a Bearer header to an HTTPS public host, or to the user's
// own loopback — never to a private/link-local address an attacker could point
// the base URL at.
describe('isSafeKeyTarget (LLM API-key exfiltration guard)', () => {
  it('allows real HTTPS public providers', () => {
    expect(isSafeKeyTarget('https://api.groq.com/openai/v1')).toBe(true);
    expect(isSafeKeyTarget('https://openrouter.ai/api/v1')).toBe(true);
    expect(isSafeKeyTarget('https://api.openai.com/v1')).toBe(true);
  });

  it('allows the user\'s own loopback (local Ollama / LM Studio)', () => {
    expect(isSafeKeyTarget('http://localhost:11434')).toBe(true);
    expect(isSafeKeyTarget('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isSafeKeyTarget('http://[::1]:11434')).toBe(true);
  });

  it('rejects plaintext HTTP to a public host', () => {
    expect(isSafeKeyTarget('http://api.groq.com/openai/v1')).toBe(false);
  });

  it('rejects private / link-local / metadata hosts even over HTTPS', () => {
    expect(isSafeKeyTarget('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeKeyTarget('https://10.0.0.5/v1')).toBe(false);
    expect(isSafeKeyTarget('https://192.168.1.10/v1')).toBe(false);
    expect(isSafeKeyTarget('https://172.16.4.2/v1')).toBe(false);
    expect(isSafeKeyTarget('https://attacker.internal/v1')).toBe(false);
    expect(isSafeKeyTarget('https://printer.local/v1')).toBe(false);
  });

  it('does not misjudge public DNS names that merely start with fc/fd', () => {
    expect(isSafeKeyTarget('https://fcbarcelona.com/v1')).toBe(true);
    expect(isSafeKeyTarget('https://fdic.gov/v1')).toBe(true);
  });

  it('rejects garbage / non-absolute URLs', () => {
    expect(isSafeKeyTarget('')).toBe(false);
    expect(isSafeKeyTarget('not a url')).toBe(false);
    expect(isSafeKeyTarget('ftp://example.com')).toBe(false);
  });
});
