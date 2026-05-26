import { vi, type MockInstance } from 'vitest';

type Handler = (body: unknown) => unknown | Response | Promise<unknown | Response>;
export type Routes = Record<string, Handler>;

/**
 * Install a fetch mock for the duration of a test.
 *
 * Routes are keyed `"METHOD /path"` and may return a JSON-serialisable value
 * (wrapped in a 200 Response) or a Response directly (for non-200s).
 * Unmocked requests throw, so tests fail loud instead of silently waiting.
 */
export function installFetchMock(routes: Routes): MockInstance {
  return vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    const path = new URL(url, 'http://localhost').pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${path}`;
    const handler = routes[key];
    if (!handler) {
      throw new Error(`unmocked fetch: ${key}`);
    }
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' && rawBody.length > 0
      ? JSON.parse(rawBody) : undefined;
    const result = await handler(body);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

export function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
