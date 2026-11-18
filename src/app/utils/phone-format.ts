export function phoneDigits(value: unknown): string {
  return String(value ?? '').replace(/\D+/g, '');
}

export function formatUsPhoneInput(value: unknown): string {
  const allDigits = phoneDigits(value);
  if (!allDigits) return '';

  // Accept optional leading country code 1 for US numbers.
  const normalized = allDigits.length > 10 && allDigits.startsWith('1')
    ? allDigits.slice(1)
    : allDigits;
  const digits = normalized.slice(0, 10);

  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function normalizePhoneToE164(value: unknown, defaultCountryCode = '1'): string {
  const text = String(value ?? '').trim();
  const digits = phoneDigits(text);
  if (!digits) return '';

  if (text.startsWith('+') && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }

  const country = phoneDigits(defaultCountryCode) || '1';
  if (country === '1') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  }

  if (digits.startsWith(country) && digits.length > country.length) {
    return `+${digits}`;
  }
  if (digits.length >= 8 && digits.length <= 15) {
    return `+${country}${digits}`;
  }
  return '';
}
