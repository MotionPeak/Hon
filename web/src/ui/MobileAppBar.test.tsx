import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileAppBar } from './MobileAppBar';

describe('MobileAppBar', () => {
  it('renders the brand wordmark (not as a heading — the desktop header owns h1)', () => {
    render(<MobileAppBar onMenu={vi.fn()} />);
    expect(screen.getByText('Hon')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /hon/i })).not.toBeInTheDocument();
  });

  it('opens the menu when the hamburger is tapped', async () => {
    const user = userEvent.setup();
    const onMenu = vi.fn();
    render(<MobileAppBar onMenu={onMenu} />);
    await user.click(screen.getByRole('button', { name: /open menu/i }));
    expect(onMenu).toHaveBeenCalledTimes(1);
  });
});
