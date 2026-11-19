import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

async function workspace(request: APIRequestContext) {
  const email = 'release-' + randomUUID() + '@example.test';
  const password = randomUUID();
  const signup = await request.post('/api/access', {
    data: { op: 'password-signup', email, password, displayName: 'Release Test', phone: '5125550100' }
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const setup = await request.post('/api/access', { data: { op: 'bootstrap', locations: ['Release Test Shop'] } });
  expect(setup.ok(), await setup.text()).toBeTruthy();
  const profile = await setup.json();
  return { email, password, tenant: profile.profile.defaultLocationId as string };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('the production build signs in using a secure cookie and survives reload and protected navigation', async ({ page, request }) => {
  const account = await workspace(request);
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const cookie = (await page.context().cookies()).find(item => item.name === 'pf_session');
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' });
  expect(await page.evaluate(() => localStorage.getItem('pathflow.dev.auth.user'))).toBeNull();
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await expect(page).toHaveURL(/\/customers$/);

  const denied = await page.request.get('/api/customers', { headers: { 'x-tenant-id': 'other-release-tenant' } });
  expect(denied.status()).toBe(403);
  const allowed = await page.request.get('/api/customers', { headers: { 'x-tenant-id': account.tenant } });
  expect(allowed.ok()).toBeTruthy();
});

test('initial anonymous bootstrap cannot erase a login cookie when its delayed response arrives', async ({ page, request }) => {
  const account = await workspace(request);
  let release!: () => void;
  let blocked!: () => void;
  const started = new Promise<void>(resolve => blocked = resolve);
  const pending = new Promise<void>(resolve => release = resolve);
  let delayed = false;
  await page.route('**/api/access?scope=me', async route => {
    if (delayed) return route.continue();
    delayed = true;
    const response = await route.fetch();
    blocked();
    await pending;
    await route.fulfill({ response });
  });
  await page.goto('/login');
  await started;
  const login = await page.request.post('/api/access', {
    data: { op: 'password-login', email: account.email, password: account.password }
  });
  expect(login.ok()).toBeTruthy();
  release();
  await page.reload();
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('hosted workspaces have complimentary access and billing does not request a card', async ({ page, request }) => {
  const account = await workspace(request);
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/billing');
  await expect(page.getByRole('status')).toContainText('without a subscription charge');
  await expect(page.getByLabel('Card number', { exact: true })).toHaveCount(0);
});

test('temporary profile failure leaves a session cookie recoverable and shows a retry action', async ({ page, request }) => {
  const account = await workspace(request);
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const before = (await page.context().cookies()).find(item => item.name === 'pf_session')!.value;
  await page.route('**/api/access?scope=me', route => route.fulfill({ status: 503, json: { ok: false } }));
  await page.reload();
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByRole('alert')).toContainText('check your sign-in');
  expect((await page.context().cookies()).find(item => item.name === 'pf_session')!.value).toBe(before);
  await page.unroute('**/api/access?scope=me');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('password success without session confirmation stays on login with an actionable error', async ({ page, request }) => {
  const account = await workspace(request);
  await page.route('**/api/access?scope=me', route => route.fulfill({
    json: { ok: false, principal: null, profile: null, roles: [] }
  }));
  await signIn(page, account.email, account.password);
  await expect(page.getByText('Unable to confirm your sign-in. Please try again.', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('production ignores browser-seeded admin data and rejects external post-login redirects', async ({ page, request }) => {
  const account = await workspace(request);
  await page.addInitScript(() => localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
    role: 'admin', email: 'forged@example.test', isSuperAdmin: true
  })));
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login\?/);
  await page.goto('/login?redirect=' + encodeURIComponent('//external.example/'));
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('a protected API 401 rechecks the session and avoids an injection error', async ({ page, request }) => {
  const account = await workspace(request);
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/customers', route => route.fulfill({ status: 401, json: { error: 'Expired' } }));
  await page.route('**/api/access?scope=me', route => route.fulfill({ json: { ok: false, principal: null } }));
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?redirect=/);
  expect(errors.filter(message => /NG0203|inject\(\)/.test(message))).toEqual([]);
});

test('the password reset view validates matching passwords and sends the single-use token', async ({ page }) => {
  const token = 'a'.repeat(64);
  await page.route('**/api/access', async route => {
    const body = route.request().postDataJSON();
    if (body?.op === 'reset-password') {
      expect(body.token).toBe(token);
      expect(body.password).toBe('NewReleasePassword-123');
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });
  await page.goto('/login#reset_' + token);
  await page.getByLabel('New password', { exact: true }).fill('NewReleasePassword-123');
  await page.getByLabel('Confirm new password', { exact: true }).fill('DifferentPassword-123');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('same password');
  await page.getByLabel('Confirm new password', { exact: true }).fill('NewReleasePassword-123');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(page.getByText('Password saved. Sign in with your new password.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('a failed invitation remains visible, reports the email error and can be resent without a false success', async ({ page, request }) => {
  const account = await workspace(request);
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const email = 'invited-' + randomUUID() + '@example.test';
  let invitationAttempts = 0;
  await page.route('**/api/access', async route => {
    const body = route.request().postDataJSON();
    if (body?.op !== 'invite-user') return route.continue();
    expect(body).toMatchObject({ name: 'Invited Staff', email, role: 'admin', tenantId: account.tenant });
    invitationAttempts++;
    if (invitationAttempts > 1) return route.continue();
    return route.fulfill({ status: 503, json: {
      ok: false, code: 'INVITATION_EMAIL_FAILED', emailSent: false, tenantId: account.tenant,
      error: 'The user was saved, but the invitation email could not be sent. Use Resend invite to try again.',
      items: [{ id: email, name: 'Invited Staff', email, role: 'admin', status: 'invited' }]
    } });
  });
  await page.goto('/admin-settings?section=users');
  await expect(page.getByRole('heading', { name: 'User Access', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Invited Staff');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('admin');
  await page.getByRole('button', { name: 'Add User', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('invitation email could not be sent');
  await expect(page.getByText('Invite sent to ' + email, { exact: false })).toHaveCount(0);
  const user = page.locator('.user-row').filter({ hasText: email });
  await expect(user).toHaveCount(1);
  await expect(user.getByText('invited', { exact: true })).toBeVisible();
  await user.getByRole('button', { name: 'Resend invite', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Invite sent to ' + email })).toContainText('72 hours (3 days)');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(user).toHaveCount(1);
  expect(invitationAttempts).toBe(2);
});

test('server WebAuthn passkeys register and authenticate in the production build', async ({ page, request, context }) => {
  const account = await workspace(request);
  const protocol = await context.newCDPSession(page);
  await protocol.send('WebAuthn.enable');
  await protocol.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true
  } });
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByLabel('Use biometrics next time').check();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const logout = await page.request.post('/api/access', { data: { op: 'logout' } });
  expect(logout.ok()).toBeTruthy();
  await page.goto('/login');
  const dialog = page.getByRole('dialog', { name: 'Sign in with Face ID / Touch ID' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Log In', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
