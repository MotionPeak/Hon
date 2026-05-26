import { defineConfig } from 'vitest/config';

// Vitest is wired to the same TypeScript + ESM setup the engine uses
// at runtime — no compile step, tsx-style loader handles the .ts files
// directly. Tests live under `tests/` (a sibling of src/) and import
// from `../src/<module>.js` (the .js suffix matches what the engine
// itself imports — TS/tsx resolves it back to the .ts source).
export default defineConfig({
  test: {
    // Discover both `tests/**/*.test.ts` and any future co-located
    // `src/**/*.test.ts` without configuring per-pattern.
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // The scrape paths talk to a live browser; tests cover ONLY pure
    // logic. Exclude anything that would launch puppeteer.
    exclude: ['node_modules', 'dist'],
    // Sensible defaults for an engine like Hon — quick local feedback
    // loop, no flaky network/IO tests in CI mode.
    testTimeout: 5_000,
    // Don't print every passing test — only failures + summary. Keeps
    // the watch-mode output scannable.
    reporters: ['default'],
  },
});
