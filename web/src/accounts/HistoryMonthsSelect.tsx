import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

/** Sync-window presets, in months. Mirrors the legacy native <select>. */
export const HISTORY_MONTHS_OPTIONS = [3, 6, 12, 18, 24] as const;

interface HistoryMonthsSelectProps {
  value: number;
  onChange: (months: number) => void;
  disabled?: boolean;
}

/**
 * Per-connection sync-window picker. A custom Radix dropdown (not a native
 * <select>) so the open menu matches the dark theme. Controlled: the parent
 * owns `value` and persists `onChange` via PATCH /history-months.
 */
export function HistoryMonthsSelect({ value, onChange, disabled }: HistoryMonthsSelectProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="mini history-trigger"
          aria-label="History months"
          disabled={disabled}
        >
          {value} mo
          <span className="hist-chev" aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" sideOffset={4} align="end">
          {HISTORY_MONTHS_OPTIONS.map((n) => (
            <DropdownMenu.Item
              key={n}
              className="menu-item"
              data-active={n === value}
              onSelect={() => onChange(n)}
            >
              <span className="hist-check" aria-hidden="true">{n === value ? '✓' : ' '}</span>
              {n} mo
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
