export function normalizeAuthRedirect(path: string | null | undefined, fallback = '/dashboard'): string {
  const value = String(path || '').trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;

  const origin = 'https://pathflow.invalid';
  const url = new URL(value, origin);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname).toLowerCase(); } catch { return fallback; }
  if (url.origin !== origin || pathname.startsWith('//') || pathname === '/.auth' || pathname.startsWith('/.auth/')) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
