// Bearer-token API client. Reads the token from the URL fragment
// (#token=<uuid>) exactly the way the old app.html does, then attaches
// `Authorization: Bearer <token>` to every fetch. Vite proxies /api/*
// to the engine (see vite.config.ts); in production the engine serves
// the React bundle directly and /api/* hits the same origin.

const token = new URLSearchParams(window.location.hash.slice(1)).get('token');

export function hasToken(): boolean {
  return !!token;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * `api('/connections')` → GET. `api('/loans', 'POST', body)` → POST + JSON body.
 * Throws an `ApiError` on any non-2xx response so callers can branch on
 * `err instanceof ApiError && err.status === 401` (token expired, etc).
 */
export async function api<T = unknown>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Routes under /api are proxied to the engine by Vite in dev and
  // served same-origin in prod. The route inside the engine is the
  // ORIGINAL path (Vite strips /api), so /api/loans → engine /loans.
  const url = path.startsWith('/api/') ? path : `/api${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // 204 No Content / 205 Reset — typed as the caller's T; the only
  // reasonable cast is undefined.
  if (res.status === 204 || res.status === 205) return undefined as unknown as T;
  // Parse JSON only when the response actually carries it. Some 4xx
  // responses are plain text; surface them as-is.
  const text = await res.text();
  let payload: unknown = text;
  try { payload = JSON.parse(text); } catch { /* not JSON, keep text */ }
  if (!res.ok) {
    const msg = typeof payload === 'object' && payload && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, payload);
  }
  return payload as T;
}
