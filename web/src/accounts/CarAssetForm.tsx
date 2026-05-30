// web/src/accounts/CarAssetForm.tsx
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';
import {
  cleanPlate, isValidPlate, vehicleName, ownershipKey, YAD2_PRICE_LIST,
  type VehicleInfo, type Ownership, type CarDetails,
} from './vehicle';

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
  const [plate, setPlate] = useState('');
  const [name, setName] = useState('');
  const [year, setYear] = useState('');
  const [km, setKm] = useState('');
  const [ownership, setOwnership] = useState<Ownership>('private');
  const [value, setValue] = useState('');
  // Spec details captured from a successful lookup, kept for the POST payload
  // and the polished spec card. Null until a lookup succeeds.
  const [spec, setSpec] = useState<VehicleInfo | null>(null);
  const [looking, setLooking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    const digits = cleanPlate(plate);
    setError(null);
    setHint(null);
    if (!isValidPlate(digits)) { setError('Enter a valid plate number.'); return; }
    setLooking(true);
    try {
      const r = await api<{ found: boolean; vehicle?: VehicleInfo }>(`/vehicle/${digits}`);
      if (r.found && r.vehicle) {
        const v = r.vehicle;
        setSpec(v);
        const nm = vehicleName(v);
        if (nm) setName(nm);
        if (v.year) setYear(String(v.year));
        const own = ownershipKey(v.ownership);
        if (own) setOwnership(own);
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

  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError("Enter the car's make and model."); return; }
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) { setError("Enter the car's current value."); return; }
    const details: CarDetails = {
      plate: cleanPlate(plate) || null,
      year: Number(year) || null,
      km: Number(km) || null,
      ownership,
      make: spec?.make ?? null,
      model: spec?.model ?? null,
      trim: spec?.trim ?? null,
      fuel: spec?.fuel ?? null,
      color: spec?.color ?? null,
    };
    try {
      await api('/assets', 'POST', {
        kind: 'car', name: name.trim(), value: v, currency: 'ILS', details,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Add a car" className="modal">
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
                value={plate}
                onChange={(e) => setPlate(e.target.value)}
                placeholder="e.g. 12345678"
                autoComplete="off"
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
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Toyota Corolla"
              autoComplete="off"
            />
          </label>

          <div className="car-grid2">
            <label className="field">
              <span>Year</span>
              <input
                type="number" min="1980" max="2030" placeholder="2020"
                value={year} onChange={(e) => setYear(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Mileage (km)</span>
              <input
                type="number" min="0" step="1000" placeholder="60000"
                value={km} onChange={(e) => setKm(e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>Ownership</span>
            <select
              value={ownership}
              onChange={(e) => setOwnership(e.target.value as Ownership)}
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
              value={value} onChange={(e) => setValue(e.target.value)}
            />
          </label>

          <button type="button" className="mini car-yad2" onClick={openYad2}>
            Look up the price on Yad2 ↗
          </button>

          {hint && <div className="est-note">{hint}</div>}
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={submit}>Add car</button>
          </div>
        </div>
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
