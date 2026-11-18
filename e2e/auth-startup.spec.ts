import { expect, test } from '@playwright/test';

test('login stays in the SPA and shows remembered biometrics', async ({ page }) => {
  const email = 'regression@example.com';
  await page.addInitScript(seedEmail => {
    localStorage.setItem('pathflow.auth.passkey.pref', JSON.stringify({ [seedEmail]: true }));
    localStorage.setItem('pathflow.auth.passkey.last-email', seedEmail);
    localStorage.setItem('pathflow.local.passkeys', JSON.stringify([{
      email: seedEmail,
      credentialId: 'cmVncmVzc2lvbg',
      createdAt: new Date().toISOString()
    }]));
  }, email);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Run your shop from first call to pickup.' })).toBeVisible();

  const documentRequests: string[] = [];
  page.on('request', request => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });

  const started = Date.now();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  const prompt = page.getByRole('dialog', { name: 'Sign in with Face ID / Touch ID' });
  await expect(prompt).toBeVisible();
  expect(Date.now() - started).toBeLessThan(2500);
  expect(documentRequests, 'SPA login navigation must not request a new document').toEqual([]);

  expect(await prompt.evaluate(dialog => dialog.matches(':modal'))).toBe(true);
  expect(await prompt.evaluate(dialog => getComputedStyle(dialog, '::backdrop').backdropFilter)).toContain('blur(');
  await expect(prompt.getByRole('heading')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(prompt.getByRole('button', { name: 'Close biometric sign-in' })).toBeFocused();
  await prompt.getByRole('button', { name: 'Use password instead' }).click();
  await expect(prompt).toBeHidden();
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
});

test('the public homepage loads its product previews and routes visitors to signup', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const dashboard = page.getByRole('img', { name: /Pathflow dashboard showing/ });
  await expect.poll(() => dashboard.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Customer portal' }).click();
  await expect(page).toHaveURL(/#customer-portal$/);
  await expect(page.getByRole('heading', { name: 'One link for the whole visit.' })).toBeInViewport();

  const reports = page.getByRole('img', { name: /Invoiced Sales and Collections report/ });
  await reports.scrollIntoViewIfNeeded();
  await expect.poll(() => reports.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  await page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true }).click();
  await expect(page).toHaveURL(/\/signup$/);
});
