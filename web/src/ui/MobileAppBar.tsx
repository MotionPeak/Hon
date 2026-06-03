import { BrandMark } from './BrandMark';

interface MobileAppBarProps {
  onMenu: () => void;
}

/** The phone top bar: hamburger (opens the drawer) + brand + theme toggle.
 *  Hidden on desktop via CSS (`min-width: 769px`). The theme toggle mirrors the
 *  existing (currently inert) one in the desktop header for parity — wiring the
 *  theme is intentionally out of scope for the shell phase. */
export function MobileAppBar({ onMenu }: MobileAppBarProps) {
  return (
    <header className="mobile-appbar">
      <button type="button" className="appbar-hamburger" aria-label="Open menu" onClick={onMenu}>
        <span className="appbar-hamburger-lines" aria-hidden="true" />
      </button>
      <span className="appbar-brand">
        <BrandMark />
        <span className="appbar-brand-word">Hon</span>
      </span>
      <span className="appbar-spacer" />
      <button
        type="button"
        className="theme-toggle icon-btn appbar-theme"
        title="Light / dark"
        aria-label="Toggle theme"
      >☀</button>
    </header>
  );
}
