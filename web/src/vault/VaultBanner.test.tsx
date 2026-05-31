import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchMock } from '../test/mockFetch';
import { VaultBanner } from './VaultBanner';
import { __resetVaultCache } from './useVault';

beforeEach(() => { __resetVaultCache(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('VaultBanner', () => {
  it('shows when the vault is locked and fires onUnlockClick', async () => {
    installFetchMock({ 'GET /api/vault/status': () => ({ exists: true, unlocked: false }) });
    const onUnlock = vi.fn();
    render(<VaultBanner onUnlockClick={onUnlock} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
    expect(onUnlock).toHaveBeenCalledOnce();
  });

  it('renders nothing when the vault is unlocked', async () => {
    installFetchMock({ 'GET /api/vault/status': () => ({ exists: true, unlocked: true }) });
    render(<VaultBanner onUnlockClick={() => {}} />);
    await waitFor(() => expect(window.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('vault-banner')).not.toBeInTheDocument();
  });

  it('renders nothing when no vault exists', async () => {
    installFetchMock({ 'GET /api/vault/status': () => ({ exists: false, unlocked: false }) });
    render(<VaultBanner onUnlockClick={() => {}} />);
    await waitFor(() => expect(window.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('vault-banner')).not.toBeInTheDocument();
  });

  it('dismisses for the session', async () => {
    installFetchMock({ 'GET /api/vault/status': () => ({ exists: true, unlocked: false }) });
    render(<VaultBanner onUnlockClick={() => {}} />);
    await screen.findByTestId('vault-banner');
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByTestId('vault-banner')).not.toBeInTheDocument();
  });
});
