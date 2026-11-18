import { normalizeShopTimeZone, shopCalendarIso, shopWallTime } from './shop-time';

describe('shop time', () => {
  it('keeps legacy appointments on the shop clock and converts explicit instants', () => {
    const zone = 'America/Los_Angeles';
    expect(shopWallTime('2026-11-09T09:00:00', zone)).toBe('2026-11-09T09:00:00');
    expect(shopWallTime('2026-11-10T01:30:00Z', zone)).toBe('2026-11-09T17:30:00.000');
    expect(shopCalendarIso('2026-11-09T09:00:00', zone)).toBe('2026-11-09T17:00:00.000Z');
    expect(shopCalendarIso('2026-11-09T09:00:00-06:00', zone)).toBe('2026-11-09T15:00:00.000Z');
  });

  it('uses the earlier occurrence when clocks fall back and advances through a skipped hour', () => {
    const zone = 'America/Chicago';
    expect(shopCalendarIso('2026-11-01T01:30:00', zone)).toBe('2026-11-01T06:30:00.000Z');
    expect(shopCalendarIso('2026-03-08T02:30:00', zone)).toBe('2026-03-08T08:30:00.000Z');
    expect(shopCalendarIso('2026-10-04T02:15:00', 'Australia/Lord_Howe')).toBe('2026-10-03T15:45:00.000Z');
  });

  it('retains valid older identifiers and falls back for missing or invalid settings', () => {
    expect(normalizeShopTimeZone(' US/Central ')).toBe('US/Central');
    expect(normalizeShopTimeZone('Mars/Olympus')).toBe('America/Chicago');
    expect(normalizeShopTimeZone(null)).toBe('America/Chicago');
  });
});
