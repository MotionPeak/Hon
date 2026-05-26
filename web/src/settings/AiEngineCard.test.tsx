import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiEngineCard } from './AiEngineCard';

describe('AiEngineCard (stub)', () => {
  it('renders an "AI engine" header', () => {
    render(<AiEngineCard />);
    expect(screen.getByRole('heading', { name: /ai engine/i })).toBeInTheDocument();
  });

  it('renders a placeholder note explaining the card is coming soon', () => {
    render(<AiEngineCard />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
