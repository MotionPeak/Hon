import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchMock, jsonResponse } from '../test/mockFetch';
import { VaultCard } from './VaultCard';
import { __resetVaultCache } from '../vault/useVault';

beforeEach(() => { __resetVaultCache(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('VaultCard', () => {
  it('shows the passphrase form when the vault is locked', async () => {
    installFetchMock({ 'GET /api/vault/status': () => ({ exists: true, unlocked: false }) });
    render(<VaultCard />);
    expect(await screen.findByText('Locked')).toBeInTheDocument();
    expect(screen.getByLabelText('Vault passphrase')).toBeInTheDocument();
  });

  it('unlocks on the right passphrase, then offers Lock', async () => {
    installFetchMock({
      'GET /api/vault/status': () => ({ exists: true, unlocked: false }),
      'POST /api/vault/unlock': () => ({ exists: true, unlocked: true }),
    });
    render(<VaultCard />);
    const input = await screen.findByLabelText('Vault passphrase');
    fireEvent.change(input, { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: /^unlock/i }));
    expect(await screen.findByText('Unlocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /lock vault/i })).toBeInTheDocument();
  });

  it('shows an error on a wrong passphrase', async () => {
    installFetchMock({
      'GET /api/vault/status': () => ({ exists: true, unlocked: false }),
      'POST /api/vault/unlock': () => jsonResponse(400, { error: 'bad key' }),
    });
    render(<VaultCard />);
    const input = await screen.findByLabelText('Vault passphrase');
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^unlock/i }));
    expect(await screen.findByText(/wrong passphrase/i)).toBeInTheDocument();
  });

  it('renders the no-vault message when none exists', async () => {
    installFetchMock({ 'GET /api/vault/status': () => ({ exists: false, unlocked: false }) });
    render(<VaultCard />);
    expect(await screen.findByText(/No saved credentials yet/i)).toBeInTheDocument();
  });
});
