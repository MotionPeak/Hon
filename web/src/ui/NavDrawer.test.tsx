import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NavDrawer } from './NavDrawer';
import { TABS } from '../nav';

afterEach(() => { document.body.className = ''; });

function setup(open = true) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <NavDrawer tabs={TABS} activeTab="overview" open={open} onSelect={onSelect} onClose={onClose} />,
  );
  return { onSelect, onClose };
}

describe('NavDrawer', () => {
  it('renders every section as a button when open', () => {
    setup(true);
    const drawer = screen.getByRole('dialog', { name: /navigation/i });
    for (const t of TABS) {
      expect(within(drawer).getByRole('button', { name: new RegExp(t.label, 'i') })).toBeInTheDocument();
    }
  });

  it('marks the active section with aria-current', () => {
    setup(true);
    const active = screen.getByRole('button', { name: /overview/i });
    expect(active).toHaveAttribute('aria-current', 'page');
  });

  it('calls onSelect then onClose when a section is tapped', async () => {
    const user = userEvent.setup();
    const { onSelect, onClose } = setup(true);
    await user.click(screen.getByRole('button', { name: /assets/i }));
    expect(onSelect).toHaveBeenCalledWith('accounts');
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when the scrim is tapped', async () => {
    const user = userEvent.setup();
    const { onClose } = setup(true);
    await user.click(screen.getByTestId('nav-scrim'));
    expect(onClose).toHaveBeenCalled();
  });

  it('locks body scroll while open and restores it when closed', () => {
    const { rerender } = render(
      <NavDrawer tabs={TABS} activeTab="overview" open onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(document.body).toHaveClass('drawer-open');
    rerender(
      <NavDrawer tabs={TABS} activeTab="overview" open={false} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(document.body).not.toHaveClass('drawer-open');
  });
});
