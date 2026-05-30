// web/src/accounts/vehicle.ts

/** Mirror of the engine's VehicleInfo (sidecar/src/vehicle.ts). All fields
 *  except plate are nullable; `ownership` is the raw Hebrew `baalut` string. */
export interface VehicleInfo {
  plate: string;
  make: string | null;
  model: string | null;
  trim: string | null;
  year: number | null;
  fuel: string | null;
  ownership: string | null;
  color: string | null;
}

export type Ownership = 'private' | 'company' | 'lease' | 'rental';

/** What we persist on a car asset's `details`. */
export interface CarDetails {
  plate: string | null;
  year: number | null;
  km: number | null;
  ownership: Ownership | '';
  make: string | null;
  model: string | null;
  trim: string | null;
  fuel: string | null;
  color: string | null;
}

/** Strip everything but digits from a raw plate input. */
export function cleanPlate(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Israeli plates are 5–8 digits. */
export function isValidPlate(digits: string): boolean {
  return digits.length >= 5 && digits.length <= 8;
}

/** "make model", tolerating either part being null/empty. */
export function vehicleName(v: Pick<VehicleInfo, 'make' | 'model'>): string {
  return [v.make, v.model].filter(Boolean).join(' ');
}

/** Map the gov registry's Hebrew `baalut` to a form ownership value.
 *  Ported verbatim from the legacy SPA (app.html:7505). */
export function ownershipKey(baalut: string | null): Ownership | '' {
  const s = String(baalut || '');
  if (s.indexOf('פרטי') >= 0) return 'private';
  if (s.indexOf('השכר') >= 0) return 'rental';
  if (s.indexOf('ליסינג') >= 0 || s.indexOf('ליס') >= 0) return 'lease';
  if (s.indexOf('חבר') >= 0) return 'company';
  return '';
}

/** Compact "2020 · 60,000 km · Blue" line for the asset card. Skips absent
 *  fields; returns '' when nothing is known. `details` is the loosely-typed
 *  bag stored on the asset, so read defensively. */
export function carSubline(details: Record<string, unknown> | null): string {
  if (!details) return '';
  const bits: string[] = [];
  const year = details.year;
  if (typeof year === 'number' && Number.isFinite(year)) bits.push(String(year));
  const km = details.km;
  if (typeof km === 'number' && Number.isFinite(km)) {
    bits.push(`${km.toLocaleString('en-US')} km`);
  }
  const color = details.color;
  if (typeof color === 'string' && color.trim()) bits.push(color.trim());
  return bits.join(' · ');
}
