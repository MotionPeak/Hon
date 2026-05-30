// web/src/accounts/CarAssetForm.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { installFetchMock } from '../test/mockFetch';
import { CarAssetForm } from './CarAssetForm';

const VEHICLE = {
  plate: '12345678', make: 'Toyota', model: 'Corolla', trim: 'SE',
  year: 2020, fuel: 'Gasoline', ownership: 'פרטי', color: 'Blue',
};

describe('CarAssetForm', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('looks up a plate and autofills the spec card', async () => {
    installFetchMock({
      'GET /api/vehicle/12345678': () => ({ found: true, vehicle: VEHICLE }),
    });
    render(<CarAssetForm onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByLabelText(/licence plate/i), {
      target: { value: '12-345-678' },
    });
    // "Look up" (exact) — the Yad2 button is "Look up the price on Yad2 ↗",
    // so a /look up/i regex matches both. Use the exact label here.
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() =>
      expect((screen.getByLabelText(/make & model/i) as HTMLInputElement).value)
        .toBe('Toyota Corolla'));
    expect((screen.getByLabelText(/year/i) as HTMLInputElement).value).toBe('2020');
    expect((screen.getByLabelText(/ownership/i) as HTMLSelectElement).value)
      .toBe('private');
    // polished spec card surfaces trim/fuel/color
    expect(screen.getByText(/SE/)).toBeInTheDocument();
    expect(screen.getByText(/Blue/)).toBeInTheDocument();
  });

  it('shows a manual-entry hint when the plate is not found, fields stay editable', async () => {
    installFetchMock({ 'GET /api/vehicle/99999': () => ({ found: false }) });
    render(<CarAssetForm onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByLabelText(/licence plate/i), {
      target: { value: '99999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() =>
      expect(screen.getByText(/enter the details by hand/i)).toBeInTheDocument());
    const name = screen.getByLabelText(/make & model/i) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Kawasaki Ninja' } });
    expect(name.value).toBe('Kawasaki Ninja');
  });

  it('requires a positive value before saving', async () => {
    installFetchMock({});
    render(<CarAssetForm onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByLabelText(/make & model/i), {
      target: { value: 'Toyota Corolla' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add car/i }));
    // Assert the exact validation message (the "Current value (₪)" label also
    // contains "current value", so a /current value/i match is ambiguous).
    await waitFor(() =>
      expect(screen.getByText(/enter the car's current value/i)).toBeInTheDocument());
    // no POST fired (mock has no /assets key — would throw if called)
  });

  it('POSTs the full spec payload and calls onSaved', async () => {
    const onSaved = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capture array for asserting the POST body shape
    const calls: any[] = [];
    installFetchMock({
      'GET /api/vehicle/12345678': () => ({ found: true, vehicle: VEHICLE }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- POST body is the asset payload under test
      'POST /api/assets': (body: any) => { calls.push(body); return { asset: { id: 'a1' } }; },
    });
    render(<CarAssetForm onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/licence plate/i), {
      target: { value: '12345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() =>
      expect((screen.getByLabelText(/make & model/i) as HTMLInputElement).value)
        .toBe('Toyota Corolla'));
    fireEvent.change(screen.getByLabelText(/current value/i), {
      target: { value: '55000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add car/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      kind: 'car', name: 'Toyota Corolla', value: 55000, currency: 'ILS',
      details: {
        plate: '12345678', year: 2020, ownership: 'private',
        make: 'Toyota', model: 'Corolla', trim: 'SE', fuel: 'Gasoline', color: 'Blue',
      },
    });
  });

  it('opens Yad2 in a new tab', () => {
    installFetchMock({});
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<CarAssetForm onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /yad2/i }));
    expect(open).toHaveBeenCalledWith('https://www.yad2.co.il/price-list', '_blank');
  });
});
