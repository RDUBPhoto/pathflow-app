export function formatLocalDateTime(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

export function toLocalDateTimeInput(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const direct = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  if (direct) return direct[1];

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return '';
  return formatLocalDateTime(new Date(timestamp)).slice(0, 16);
}

export function toLocalDateTimeStorage(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const simple = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/);
  if (simple) return `${simple[1]}:${simple[2] || '00'}`;

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return '';
  return formatLocalDateTime(new Date(timestamp));
}
