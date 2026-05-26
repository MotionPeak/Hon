import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SplitwiseCard } from './SplitwiseCard';

describe('SplitwiseCard (stub)', () => {
  it('renders a "Splitwise" header', () => {
    render(<SplitwiseCard />);
    expect(screen.getByRole('heading', { name: /splitwise/i })).toBeInTheDocument();
  });

  it('renders a placeholder note explaining the card is coming soon', () => {
    render(<SplitwiseCard />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
