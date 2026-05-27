import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InteractiveSignInModal } from './InteractiveSignInModal';
import type { Company } from './types';

const meitav: Company = {
  id: 'meitav', name: 'Meitav', loginFields: ['id', 'phone'],
  type: 'pension', interactive: true,
};

describe('InteractiveSignInModal', () => {
  it('renders the company name in the header', () => {
    render(<InteractiveSignInModal company={meitav} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: /sign in.*meitav/i })).toBeInTheDocument();
  });

  it('renders the sign-in-in-browser-window copy', () => {
    render(<InteractiveSignInModal company={meitav} onClose={() => {}} />);
    expect(screen.getByText(/browser window has opened/i)).toBeInTheDocument();
  });

  it('renders the hints slot when provided', () => {
    render(
      <InteractiveSignInModal
        company={meitav}
        onClose={() => {}}
        hints={<p data-testid="hint">Meitav-specific tip</p>}
      />,
    );
    expect(screen.getByTestId('hint')).toBeInTheDocument();
  });

  it('calls onClose when the Close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<InteractiveSignInModal company={meitav} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
