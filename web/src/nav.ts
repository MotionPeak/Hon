import type { Tab } from './store/uiStore';

export interface TabDef {
  id: Tab;
  label: string;
  emoji: string;
}

export const TABS: TabDef[] = [
  { id: 'overview',  label: 'Overview',    emoji: '📊' },
  { id: 'accounts',  label: 'Assets',      emoji: '🏦' },
  { id: 'activity',  label: 'Activity',    emoji: '🧾' },
  { id: 'recurring', label: 'Fixed bills', emoji: '📆' },
  { id: 'piggy',     label: 'Piggy banks', emoji: '🐷' },
  { id: 'loans',     label: 'Loans',       emoji: '📉' },
  { id: 'vouchers',  label: 'Vouchers',    emoji: '🎟️' },
  { id: 'insights',  label: 'Insights',    emoji: '💡' },
  { id: 'settings',  label: 'Settings',    emoji: '⚙️' },
];
