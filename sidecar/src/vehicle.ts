// Looks up an Israeli vehicle by licence plate via the government open-data
// portal (data.gov.il). This returns registration details only — make, model,
// year, etc. No public Israeli API returns a market valuation from a plate, so
// the app estimates value itself and lets the user correct it.

const ENDPOINT = 'https://data.gov.il/api/3/action/datastore_search';
// Ministry of Transport "private & commercial vehicles" registry.
const RESOURCE_ID = '053cea08-09bc-40ec-8f7a-156f0677aff3';

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

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

/**
 * Resolves an Israeli plate number to its registered vehicle, or null when the
 * plate is not in the registry (e.g. motorcycles, deregistered cars) or the
 * lookup fails.
 */
export async function lookupVehicle(plate: string): Promise<VehicleInfo | null> {
  const digits = plate.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 8) return null;

  const url =
    `${ENDPOINT}?resource_id=${RESOURCE_ID}` +
    `&q=${encodeURIComponent(digits)}&limit=10`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  let payload: unknown;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`data.gov.il HTTP ${res.status}`);
    payload = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const records = (payload as { result?: { records?: Record<string, unknown>[] } })
    ?.result?.records;
  if (!Array.isArray(records)) return null;

  // `q` is a free-text search, so confirm a record's plate matches exactly.
  const record = records.find(
    (r) => String(r.mispar_rechev ?? '').replace(/\D/g, '') === digits,
  );
  if (!record) return null;

  const year = Number(record.shnat_yitzur);
  return {
    plate: digits,
    make: cleanString(record.tozeret_nm),
    model: cleanString(record.kinuy_mishari) ?? cleanString(record.degem_nm),
    trim: cleanString(record.ramat_gimur),
    year: Number.isFinite(year) && year > 1950 ? year : null,
    fuel: cleanString(record.sug_delek_nm),
    ownership: cleanString(record.baalut),
    color: cleanString(record.tzeva_rechev),
  };
}
