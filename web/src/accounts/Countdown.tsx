import { useEffect, useState } from 'react';

interface Props {
  deadlineMs: number;
}

/**
 * Displays MM:SS remaining until `deadlineMs`. Owns its own 1s tick so
 * the parent doesn't re-render every second.
 */
export function Countdown({ deadlineMs }: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  const remainingMs = Math.max(0, deadlineMs - Date.now());
  const total = Math.floor(remainingMs / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return <span className="snaptrade-countdown">{minutes}:{String(seconds).padStart(2, '0')}</span>;
}
