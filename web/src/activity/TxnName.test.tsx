import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TxnName } from './TxnName';

describe('TxnName', () => {
  it('shows only the description when no custom title', () => {
    render(<TxnName t={{ description: 'SHUFERSAL', customTitle: null, notes: null }} />);
    expect(screen.getByText('SHUFERSAL')).toBeInTheDocument();
    expect(screen.queryByTestId('txn-realname')).toBeNull();
  });
  it('shows the title with the real name beneath when titled', () => {
    render(<TxnName t={{ description: 'SHUFERSAL', customTitle: 'Lunch', notes: null }} />);
    expect(screen.getByText('Lunch')).toBeInTheDocument();
    expect(screen.getByTestId('txn-realname')).toHaveTextContent('SHUFERSAL');
  });
  it('renders a note icon when notes are present', () => {
    render(<TxnName t={{ description: 'X', customTitle: null, notes: 'remember' }} />);
    expect(screen.getByLabelText(/has a note/i)).toBeInTheDocument();
  });
});
