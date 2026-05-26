import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('runs vitest with jsdom + jest-dom matchers', () => {
    const el = document.createElement('div');
    el.textContent = 'hello';
    document.body.appendChild(el);
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent('hello');
  });
});
