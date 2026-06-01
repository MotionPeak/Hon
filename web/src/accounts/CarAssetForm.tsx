// web/src/accounts/CarAssetForm.tsx
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from '../api';
import {
  cleanPlate, isValidPlate, vehicleName, ownershipKey, YAD2_PRICE_LIST,
  type VehicleInfo, type Ownership, type CarDetails,
} from './vehicle';

// Local form schema — the car form doesn't map 1:1 to assetCreateSchema because
// it carries the plate-lookup UI fields (plate/year/km/ownership) that get folded
// into the asset's `details` bag at submit. The numeric `value` is the only field
// the schema strictly validates (with the exact message the tests assert); name
// uses the same message the manual flow used. year/km/plate stay free-text so a
// failed lookup is never a dead end.
const carFormSchema = z.object({
  plate: z.string(),
  name: z.string().trim().min(1, "Enter the car's make and model."),
  year: z.string(),
  km: z.string(),
  ownership: z.enum(['private', 'company', 'lease', 'rental']),
  // Kept as a string field (like year/km) so the input renders empty on open
  // rather than a stray "0", matching the original UX. Refined to be a positive
  // number, parsed to a real number in onSubmit — mirroring the old
  // `Number(value) <= 0` guard and its exact message.
  value: z
    .string()
    .refine((s) => Number.isFinite(Number(s)) && Number(s) > 0, {
      message: "Enter the car's current value.",
    }),
});
type CarForm = z.infer<typeof carFormSchema>;

/** Local portal helper, mirroring the one in AccountsView (module-private
 *  there, so duplicated here rather than exported). Renders to document.body
 *  so the modal escapes the card's stacking/overflow context. */
function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

interface CarAssetFormProps {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const OWNERSHIP_OPTIONS: { value: Ownership; label: string }[] = [
  { value: 'private', label: 'Private' },
  { value: 'company', label: 'Company' },
  { value: 'lease', label: 'Lease' },
  { value: 'rental', label: 'Ex-rental' },
];

/**
 * Add-a-car modal. Plate lookup (GET /vehicle/:plate) autofills a polished
 * spec card; every field stays editable so a failed lookup is never a dead
 * end. Saves via POST /assets with the full vehicle spec in `details` so the
 * value can be re-checked later. No engine changes — both routes exist.
 *
 * Follows the AddManualAssetForm DOM/class conventions (.overlay > .modal /
 * .field labels / .modal-err / .modal-actions / .primary button).
 */
export function CarAssetForm({ onClose, onSaved }: CarAssetFormProps) {
  // react-hook-form owns the editable fields (plate/name/year/km/ownership/value).
  // The plate-lookup flow writes its autofills back through setValue, so a
  // successful lookup updates the same RHF state the user can then edit.
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CarForm>({
    resolver: zodResolver(carFormSchema),
    defaultValues: { plate: '', name: '', year: '', km: '', ownership: 'private', value: '' },
  });

  // Register the picker field once so RHF tracks it; the <select> drives it.
  register('ownership');
  const plate = watch('plate');
  const ownership = watch('ownership');

  // Spec details captured from a successful lookup, kept for the POST payload
  // and the polished spec card. Null until a lookup succeeds.
  const [spec, setSpec] = useState<VehicleInfo | null>(null);
  const [looking, setLooking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // Plate-lookup errors are distinct from form-submit errors (which live in
  // RHF's errors.root) — a bad plate shouldn't read like a save failure.
  const [lookupError, setLookupError] = useState<string | null>(null);

  const lookup = async () => {
    const digits = cleanPlate(plate);
    setLookupError(null);
    setHint(null);
    if (!isValidPlate(digits)) { setLookupError('Enter a valid plate number.'); return; }
    setLooking(true);
    try {
      const r = await api<{ found: boolean; vehicle?: VehicleInfo }>(`/vehicle/${digits}`);
      if (r.found && r.vehicle) {
        const v = r.vehicle;
        setSpec(v);
        const nm = vehicleName(v);
        if (nm) setValue('name', nm, { shouldValidate: true });
        if (v.year) setValue('year', String(v.year));
        const own = ownershipKey(v.ownership);
        if (own) setValue('ownership', own);
        setHint(`Found ${nm || 'vehicle'}${v.year ? ` · ${v.year}` : ''}.`);
      } else {
        setSpec(null);
        setHint('No car found for that plate — enter the details by hand.');
      }
    } catch {
      setSpec(null);
      setHint('Lookup failed — enter the details by hand.');
    } finally {
      setLooking(false);
    }
  };

  const openYad2 = () => { window.open(YAD2_PRICE_LIST, '_blank'); };

  const submit = handleSubmit(async (values) => {
    const details: CarDetails = {
      plate: cleanPlate(values.plate) || null,
      year: Number(values.year) || null,
      km: Number(values.km) || null,
      ownership: values.ownership,
      make: spec?.make ?? null,
      model: spec?.model ?? null,
      trim: spec?.trim ?? null,
      fuel: spec?.fuel ?? null,
      color: spec?.color ?? null,
    };
    try {
      await api('/assets', 'POST', {
        kind: 'car', name: values.name.trim(), value: Number(values.value), currency: 'ILS', details,
      });
      await onSaved();
    } catch (e) {
      setError('root', { message: e instanceof ApiError ? e.message : String(e) });
    }
  });

  return (
    <ModalPortal>
      <div className="overlay">
        <form role="dialog" aria-label="Add a car" className="modal" onSubmit={submit}>
          <h2>Add a car</h2>
          <p>
            Look the car up by its plate, then check its market price on Yad2 —
            or set the value yourself.
          </p>

          <label className="field">
            <span>Licence plate</span>
            <div className="car-plate-row">
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 12345678"
                autoComplete="off"
                {...register('plate')}
              />
              <button type="button" className="mini" onClick={lookup} disabled={looking}>
                {looking ? '…' : 'Look up'}
              </button>
            </div>
          </label>

          {spec && <CarSpecCard spec={spec} />}

          <label className="field">
            <span>Make &amp; model</span>
            <input
              type="text"
              placeholder="Toyota Corolla"
              autoComplete="off"
              {...register('name')}
            />
            {errors.name && <span className="field-err">{errors.name.message}</span>}
          </label>

          <div className="car-grid2">
            <label className="field">
              <span>Year</span>
              <input
                type="number" min="1980" max="2030" placeholder="2020"
                {...register('year')}
              />
            </label>
            <label className="field">
              <span>Mileage (km)</span>
              <input
                type="number" min="0" step="1000" placeholder="60000"
                {...register('km')}
              />
            </label>
          </div>

          <label className="field">
            <span>Ownership</span>
            <select
              value={ownership}
              onChange={(e) => setValue('ownership', e.target.value as Ownership)}
            >
              {OWNERSHIP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Current value (₪)</span>
            <input
              type="number" min="0" step="500" placeholder="0"
              {...register('value')}
            />
            {errors.value && <span className="field-err">{errors.value.message}</span>}
          </label>

          <button type="button" className="mini car-yad2" onClick={openYad2}>
            Look up the price on Yad2 ↗
          </button>

          {hint && <div className="est-note">{hint}</div>}
          {lookupError && <div className="modal-err">{lookupError}</div>}
          {errors.root && <div className="modal-err">{errors.root.message}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={isSubmitting}>Add car</button>
          </div>
        </form>
      </div>
    </ModalPortal>
  );
}

/** Polished read-only summary of a successful plate lookup. */
function CarSpecCard({ spec }: { spec: VehicleInfo }) {
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, v: string | number | null) => {
    if (v != null && String(v).trim()) rows.push({ label, value: String(v) });
  };
  push('Make', spec.make);
  push('Model', spec.model);
  push('Trim', spec.trim);
  push('Year', spec.year);
  push('Fuel', spec.fuel);
  push('Colour', spec.color);
  if (rows.length === 0) return null;
  return (
    <div className="car-spec-card">
      {rows.map((r) => (
        <div key={r.label} className="car-spec-row">
          <span className="car-spec-label">{r.label}</span>
          <span className="car-spec-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
