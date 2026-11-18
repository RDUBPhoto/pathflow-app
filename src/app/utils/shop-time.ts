export const DEFAULT_SHOP_TIME_ZONE = 'America/Chicago';
export const SCHEDULE_SETTINGS_KEY = 'schedule.settings';

const FALLBACK_ZONES = [
  'America/Anchorage', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/New_York', 'America/Phoenix', 'Europe/London', 'Pacific/Honolulu'
];
const WALL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const DAY_MS = 86_400_000;
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

export function shopTimeZones(): string[] {
  return [...new Set(['UTC', ...(Intl.supportedValuesOf?.('timeZone') ?? FALLBACK_ZONES)])];
}

export function validShopTimeZone(value: unknown): string | null {
  const zone = String(value ?? '').trim();
  if (!/^[a-z][\w+./-]*$/i.test(zone)) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

export function normalizeShopTimeZone(value: unknown): string {
  return validShopTimeZone(value) ?? DEFAULT_SHOP_TIME_ZONE;
}

/** DayPilot and legacy appointments use clock time at the shop, without an offset. */
export function shopWallTime(value: string | number, timeZone: string): string {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'string' && WALL_TIME.test(raw)) return raw;
  const timestamp = typeof raw === 'number' ? raw : Date.parse(raw);
  if (!Number.isFinite(timestamp)) return '';

  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
    });
    clockFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}.${parts['fractionalSecond']}`;
}

/** Interpret clock time at the shop. Explicit offsets already identify an instant. */
export function shopTimeMillis(value: string | undefined, timeZone: string): number {
  const raw = value?.trim() ?? '';
  if (!WALL_TIME.test(raw)) return Date.parse(raw);
  const wall = Date.parse(`${raw}Z`);
  if (!Number.isFinite(wall)) return NaN;
  const offsetAt = (timestamp: number) => Date.parse(`${shopWallTime(timestamp, timeZone)}Z`) - timestamp;
  const before = wall - offsetAt(wall - DAY_MS);
  const after = wall - offsetAt(wall + DAY_MS);
  // Use the first occurrence in a repeated hour and advance by the gap for a skipped hour.
  const beforeWall = Date.parse(`${shopWallTime(before, timeZone)}Z`);
  return beforeWall >= wall ? before : after;
}

export function formatShopAppointment(startValue: string, endValue: string, timeZone: string): string {
  const start = shopTimeMillis(startValue, timeZone);
  const end = shopTimeMillis(endValue, timeZone);
  if (!Number.isFinite(start)) return 'your scheduled appointment';

  const dateFormat = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const date = dateFormat.format(start);
  const startTime = timeFormat.format(start);
  if (!Number.isFinite(end)) return `${date} at ${startTime}`;
  const endDate = dateFormat.format(end);
  const endTime = timeFormat.format(end);
  return `${date} at ${startTime} - ${endDate === date ? endTime : `${endDate} at ${endTime}`}`;
}

export function shopCalendarIso(value: string, timeZone: string): string {
  const timestamp = shopTimeMillis(value, timeZone);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}
