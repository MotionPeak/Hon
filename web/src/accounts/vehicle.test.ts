// web/src/accounts/vehicle.test.ts
import { describe, it, expect } from 'vitest';
import {
  cleanPlate, isValidPlate, vehicleName, ownershipKey, carSubline,
} from './vehicle';

describe('cleanPlate', () => {
  it('strips non-digits', () => {
    expect(cleanPlate('12-345-67')).toBe('1234567');
    expect(cleanPlate(' 123 45 ')).toBe('12345');
    expect(cleanPlate('abc')).toBe('');
  });
});

describe('isValidPlate', () => {
  it('accepts 5–8 digits, rejects outside', () => {
    expect(isValidPlate('1234')).toBe(false);
    expect(isValidPlate('12345')).toBe(true);
    expect(isValidPlate('12345678')).toBe(true);
    expect(isValidPlate('123456789')).toBe(false);
  });
});

describe('vehicleName', () => {
  it('joins make and model, tolerating missing parts', () => {
    expect(vehicleName({ make: 'Toyota', model: 'Corolla' })).toBe('Toyota Corolla');
    expect(vehicleName({ make: 'Toyota', model: null })).toBe('Toyota');
    expect(vehicleName({ make: null, model: 'Corolla' })).toBe('Corolla');
    expect(vehicleName({ make: null, model: null })).toBe('');
  });
});

describe('ownershipKey', () => {
  it('maps Hebrew baalut to a form value', () => {
    expect(ownershipKey('פרטי')).toBe('private');
    expect(ownershipKey('השכרה')).toBe('rental');
    expect(ownershipKey('ליסינג')).toBe('lease');
    expect(ownershipKey('חברה')).toBe('company');
    expect(ownershipKey('')).toBe('');
    expect(ownershipKey(null)).toBe('');
    expect(ownershipKey('something else')).toBe('');
  });
});

describe('carSubline', () => {
  it('builds a year · km · color line, skipping absent fields', () => {
    expect(carSubline({ year: 2020, km: 60000, color: 'Blue' }))
      .toBe('2020 · 60,000 km · Blue');
    expect(carSubline({ year: 2020 })).toBe('2020');
    expect(carSubline({ km: 1500 })).toBe('1,500 km');
    expect(carSubline({})).toBe('');
    expect(carSubline(null)).toBe('');
  });
});
