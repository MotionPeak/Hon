/** The Hon logo mark. Single source for the desktop header + the mobile app bar. */
export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="hm-g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1f1810" />
            <stop offset="100%" stopColor="#2d2010" />
          </linearGradient>
        </defs>
        <g fill="url(#hm-g)">
          <rect x="4" y="7" width="24" height="4.6" rx="2.3" />
          <rect x="4" y="7" width="4.6" height="21" rx="2.3" />
          <rect x="23.4" y="14" width="4.6" height="14" rx="2.3" />
        </g>
        <path d="M5.5 7.8 L26.5 7.8" stroke="rgba(255,255,255,0.22)" strokeWidth="0.9"
          strokeLinecap="round" fill="none" />
      </svg>
    </span>
  );
}
