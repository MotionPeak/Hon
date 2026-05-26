import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { loadSettings, saveSettings, type Settings } from './store';

type Update = (patch: Partial<Settings>) => void;
type Ctx = [Settings, Update];

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const update = useCallback<Update>((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  const value = useMemo<Ctx>(() => [settings, update], [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
}
