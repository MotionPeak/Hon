import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchMock, jsonResponse } from '../test/mockFetch';
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

  it('shows the banner with a Retry affordance when the status probe fails', async () => {
    // A failed /vault/status must NOT be treated as "no vault" — that would
    // hide the only unlock surface for a locked vault (M9). Suppress the
    // expected console.warn so the test output stays clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFetchMock({ 'GET /api/vault/status': () => jsonResponse(500, { error: 'down' }) });
    render(<VaultBanner onUnlockClick={() => {}} />);
    expect(await screen.findByTestId('vault-banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  });

  it('dismisses for the session', async () => {
    installFetchMock({ 'GET /api/vault/status': () => ({ exists: true, unlocked: false }) });
    render(<VaultBanner onUnlockClick={() => {}} />);
    await screen.findByTestId('vault-banner');
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByTestId('vault-banner')).not.toBeInTheDocument();
  });
});
