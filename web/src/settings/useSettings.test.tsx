import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsProvider, useSettings } from './useSettings';
import { DEFAULT_SETTINGS, loadSettings } from './store';

function Probe() {
  const [settings, update] = useSettings();
  return (
    <div>
      <span data-testid="start">{settings.monthStartDay}</span>
      <button onClick={() => update({ monthStartDay: 15 })}>bump</button>
    </div>
  );
}

describe('useSettings (inside SettingsProvider)', () => {
  it('exposes the loaded settings to consumers', () => {
    localStorage.setItem('honSettings', JSON.stringify({ monthStartDay: 10 }));
    render(<SettingsProvider><Probe /></SettingsProvider>);
    expect(screen.getByTestId('start')).toHaveTextContent('10');
  });

  it('falls back to defaults when no settings are stored', () => {
    render(<SettingsProvider><Probe /></SettingsProvider>);
    expect(screen.getByTestId('start')).toHaveTextContent(String(DEFAULT_SETTINGS.monthStartDay));
  });

  it('update() patches state and persists to localStorage', async () => {
    const user = userEvent.setup();
    render(<SettingsProvider><Probe /></SettingsProvider>);
    await user.click(screen.getByRole('button', { name: 'bump' }));
    expect(screen.getByTestId('start')).toHaveTextContent('15');
    expect(loadSettings().monthStartDay).toBe(15);
  });

  it('multiple consumers see the same state', async () => {
    const user = userEvent.setup();
    function TwoProbes() {
      return (<><Probe /><Probe /></>);
    }
    render(<SettingsProvider><TwoProbes /></SettingsProvider>);
    const [a, b] = screen.getAllByTestId('start');
    expect(a).toHaveTextContent(String(DEFAULT_SETTINGS.monthStartDay));
    await user.click(screen.getAllByRole('button', { name: 'bump' })[0]);
    expect(a).toHaveTextContent('15');
    expect(b).toHaveTextContent('15');
  });

  it('throws when useSettings is called outside the provider', () => {
    // Suppress React's error boundary noise; we only care about the throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/SettingsProvider/);
    spy.mockRestore();
  });
});
