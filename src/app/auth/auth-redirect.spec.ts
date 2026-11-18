import { normalizeAuthRedirect } from './auth-redirect';

describe('authentication redirects', () => {
  it('keeps local deep links and rejects external or authentication-provider destinations', () => {
    expect(normalizeAuthRedirect('/invoices/abc?tab=history#payments')).toBe('/invoices/abc?tab=history#payments');
    for (const destination of ['https://external.example', '//external.example', '/\\external.example', '/.auth/logout', '/.%61uth/login/aad']) {
      expect(normalizeAuthRedirect(destination)).withContext(destination).toBe('/dashboard');
    }
  });
});
