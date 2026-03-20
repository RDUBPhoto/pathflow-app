import { expect, test } from '@playwright/test';

const API_HEALTH_MAX_MS = 5000;
const PAGE_LOAD_MAX_MS = 10000;

type RuntimeProbe = {
  stop: () => { pageErrors: string[]; consoleErrors: string[]; failedRequests: string[] };
};

function startRuntimeProbe(page: import('@playwright/test').Page): RuntimeProbe {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  const onPageError = (err: Error) => {
    pageErrors.push(err?.message || String(err));
  };

  const onConsole = (msg: import('@playwright/test').ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (!text) return;
    consoleErrors.push(text);
  };

  const onRequestFailed = (request: import('@playwright/test').Request) => {
    const type = request.resourceType();
    if (!['document', 'script', 'stylesheet', 'fetch', 'xhr'].includes(type)) return;
    const failure = request.failure();
    const reason = failure?.errorText || 'unknown';
    failedRequests.push(`${type} ${request.url()} (${reason})`);
  };

  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);

  return {
    stop: () => {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      return { pageErrors, consoleErrors, failedRequests };
    }
  };
}

async function gotoAndAssertHealthy(
  page: import('@playwright/test').Page,
  route: string,
  verify: () => Promise<void>
): Promise<void> {
  const probe = startRuntimeProbe(page);
  const started = Date.now();
  await page.goto(route, { waitUntil: 'networkidle' });
  await verify();
  const elapsed = Date.now() - started;
  expect(elapsed, `${route} should load within ${PAGE_LOAD_MAX_MS}ms`).toBeLessThanOrEqual(PAGE_LOAD_MAX_MS);
  const runtime = probe.stop();
  expect(runtime.pageErrors, `${route} had page runtime errors`).toEqual([]);
  expect(runtime.consoleErrors, `${route} had console errors`).toEqual([]);
  expect(runtime.failedRequests, `${route} had failed critical requests`).toEqual([]);
}

test.describe('Hosted Smoke', () => {
  test.beforeEach(async ({ baseURL }) => {
    test.skip(!baseURL || /localhost|127\.0\.0\.1/.test(baseURL), 'Hosted smoke tests require a deployed base URL.');
  });

  test('platform health endpoints respond quickly', async ({ request }) => {
    const authStarted = Date.now();
    const authMe = await request.get('/.auth/me');
    const authElapsed = Date.now() - authStarted;
    expect(authMe.status(), '/.auth/me should respond 2xx').toBeGreaterThanOrEqual(200);
    expect(authMe.status(), '/.auth/me should respond 2xx').toBeLessThan(300);
    expect(authElapsed, `/.auth/me should respond within ${API_HEALTH_MAX_MS}ms`).toBeLessThanOrEqual(API_HEALTH_MAX_MS);
    await expect(authMe.json()).resolves.toHaveProperty('clientPrincipal');

    const pingStarted = Date.now();
    const ping = await request.get('/api/ping', { maxRedirects: 0 });
    const pingElapsed = Date.now() - pingStarted;
    const pingStatus = ping.status();
    expect([200, 301, 302, 401, 403], `/api/ping returned unexpected status ${pingStatus}`).toContain(pingStatus);
    expect(pingElapsed, `/api/ping should respond within ${API_HEALTH_MAX_MS}ms`).toBeLessThanOrEqual(API_HEALTH_MAX_MS);
  });

  test('critical public pages render without runtime or network errors', async ({ page, baseURL }) => {
    const checks: Array<{ route: string; verify: () => Promise<void> }> = [
      {
        route: '/',
        verify: async () => {
          await expect(page.getByRole('heading', { level: 1, name: /Run Leads, Quotes, Invoices/i })).toBeVisible();
        }
      },
      {
        route: '/login',
        verify: async () => {
          await expect(page.getByRole('heading', { level: 1, name: /sign in/i })).toBeVisible();
          await expect(page.getByRole('button', { name: /continue with|sign in with|login/i }).first()).toBeVisible();
        }
      },
      {
        route: '/privacy-policy',
        verify: async () => {
          await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
        }
      },
      {
        route: '/terms-and-conditions',
        verify: async () => {
          await expect(page.getByRole('heading', { level: 1, name: 'Terms and Conditions' })).toBeVisible();
        }
      },
      {
        route: '/sms-opt-in',
        verify: async () => {
          await expect(page.getByText(/SMS Opt-In|Pathflow Customer Updates|consent/i).first()).toBeVisible();
        }
      }
    ];

    for (const check of checks) {
      await gotoAndAssertHealthy(page, check.route, check.verify);
    }

    expect(page.url()).toMatch(/^https?:\/\//);
  });

  test('protected route redirects to login when unauthenticated', async ({ page }) => {
    const response = await page.goto('/dashboard');
    expect(response?.status(), '/dashboard response should not be 5xx').toBeLessThan(500);
    await expect(page).toHaveURL(/\/login/);
  });

  test('quote and invoice public fallbacks remain available for broken/missing links', async ({ page }) => {
    await page.goto('/quote-accepted?action=accept&tenantId=main&quoteNumber=QTE-TEST', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Quote Accepted')).toBeVisible();
    await expect(page.getByText('Quote response captured.')).toBeVisible();

    await page.goto('/invoice-payment?tenantId=main', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Invoice is missing.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Checkout & Pay' })).toBeDisabled();
  });
});
