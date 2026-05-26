import { useEffect, useState } from 'react';

/**
 * A loading indicator that hides itself for the first `delayMs` (default
 * 250ms) — long enough to swallow the one-frame flash you'd otherwise see
 * when a parent waits on a cached request that returns in ~5-50ms, short
 * enough that a genuinely slow request still gets an indicator on screen.
 *
 * Lifted out of every view's local `<p>Loading…</p>` so the tab-switch
 * animation isn't interrupted by a tiny "Loading…" pop in the top-left.
 */
export function DelayedLoader({
  delayMs = 250,
  text = 'Loading…',
}: {
  delayMs?: number;
  text?: string;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(h);
  }, [delayMs]);
  if (!show) return null;
  return <p className="delayed-loader">{text}</p>;
}
