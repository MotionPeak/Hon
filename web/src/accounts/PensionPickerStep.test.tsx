import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PensionPickerStep } from './PensionPickerStep';
import type { Company } from './types';

const companies: Company[] = [
  { id: 'hapoalim', name: 'Bank Hapoalim', loginFields: ['id', 'password'], type: 'bank' },
  { id: 'migdal',  name: 'Migdal',  loginFields: ['id'], type: 'pension' },
  { id: 'harel',   name: 'Harel',   loginFields: ['id'], type: 'pension' },
  { id: 'meitav',  name: 'Meitav',  loginFields: ['id', 'phone'], type: 'pension', interactive: true },
];

describe('PensionPickerStep', () => {
  it('renders one row per pension company; non-pension companies excluded', () => {
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /migdal/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /harel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /meitav/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bank hapoalim/i })).not.toBeInTheDocument();
  });

  it('tags non-interactive providers as Automatic', () => {
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    const migdalRow = screen.getByRole('button', { name: /migdal/i });
    expect(within(migdalRow).getByText(/automatic/i)).toBeInTheDocument();
  });

  it('tags interactive providers as needing a browser window', () => {
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    const meitavRow = screen.getByRole('button', { name: /meitav/i });
    expect(within(meitavRow).getByText(/browser window/i)).toBeInTheDocument();
  });

  it('renders a trailing "Custom pension account" row', () => {
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /custom pension account/i })).toBeInTheDocument();
  });

  it('calls onPickCompany with the picked provider', async () => {
    const user = userEvent.setup();
    const onPickCompany = vi.fn();
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={onPickCompany}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /harel/i }));
    expect(onPickCompany).toHaveBeenCalledTimes(1);
    const harel = companies.find((c) => c.id === 'harel')!;
    expect(onPickCompany).toHaveBeenCalledWith(harel);
  });

  it('calls onPickCustom when the custom row is clicked', async () => {
    const user = userEvent.setup();
    const onPickCustom = vi.fn();
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={onPickCustom}
        onBack={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /custom pension account/i }));
    expect(onPickCustom).toHaveBeenCalledTimes(1);
  });

  it('calls onBack when the back button is clicked', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={onBack}
      />,
    );
    await user.click(screen.getByRole('button', { name: /all categories/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders only the custom row + a hint when no pension companies exist', () => {
    render(
      <PensionPickerStep
        companies={companies.filter((c) => c.type !== 'pension')}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /custom pension account/i })).toBeInTheDocument();
    expect(screen.getByText(/no scraped providers/i)).toBeInTheDocument();
  });
});
