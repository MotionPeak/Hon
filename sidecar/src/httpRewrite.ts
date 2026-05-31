// sidecar/src/httpRewrite.ts

/**
 * Strips a single leading `/api` segment from a request URL so the React
 * client's `/api/<route>` calls reach the engine's `/<route>` handlers — the
 * production equivalent of vite's dev proxy (which does the same strip). Used as
 * Fastify's `rewriteUrl`. Only an exact `/api` prefix (followed by `/`, `?`, or
 * end-of-string) is stripped, so `/apiary` and `/api-keys` are left alone.
 */
export function rewriteApiPrefix(url: string): string {
  if (url === '/api' || url === '/api/') return '/';
  if (url.startsWith('/api/')) return url.slice(4); // drop "/api", keep the rest incl. leading "/"
  if (url.startsWith('/api?')) return '/' + url.slice(4); // "/api?x" → "/?x"
  return url;
}
