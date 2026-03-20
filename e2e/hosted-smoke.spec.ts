import { expect, test } from '@playwright/test';

test.describe('Hosted Smoke', () => {
  test('site responds and login page is reachable', async ({ page, request, baseURL }) => {
    const ping = await request.get('/api/ping');
    expect(ping.ok(), 'Expected /api/ping to return 2xx').toBeTruthy();

    await page.goto('/login');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('h2', { hasText: 'Sign in to Pathflow' })).toBeVisible();

    if (baseURL) {
      const current = new URL(page.url());
      const expected = new URL(baseURL);
      expect(current.host).toBe(expected.host);
    }
  });

  test('protected route redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('public quote accepted page handles missing quote id', async ({ page }) => {
    await page.goto('/quote-accepted?action=accept&tenantId=main&quoteNumber=QTE-TEST');
    await expect(page.getByText('Quote Accepted')).toBeVisible();
    await expect(page.getByText('Quote response captured.')).toBeVisible();
  });

  test('public invoice payment page blocks checkout when invoice id is missing', async ({ page }) => {
    await page.goto('/invoice-payment?tenantId=main');
    await expect(page.getByText('Invoice is missing.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Checkout & Pay' })).toBeDisabled();
  });
});
