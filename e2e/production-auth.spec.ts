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
  let rejected = false;
  await page.route('**/api/customers', route => {
    rejected = true;
    return route.fulfill({ status: 401, json: { error: 'Expired' } });
  });
  await page.route('**/api/access?scope=me', route => rejected
    ? route.fulfill({ json: { ok: false, principal: null } }) : route.continue());
  await page.goto('/customers');
  await expect(page).toHaveURL(/\/login\?redirect=/);
  expect(rejected).toBeTruthy();
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


test('a returning website lead keeps both vehicles and carries the new vehicle into its quote', async ({ page, request }) => {
  const account = await workspace(request);
  const headers = { 'x-tenant-id': account.tenant };
  const customerResponse = await request.post('/api/customers', { headers, data: {
    name: 'Returning Vehicle Customer', email: 'returning@example.invalid', phone: '+15125550182',
    vehicleYear: '2013', vehicleMake: 'Ford', vehicleModel: 'Raptor', vehicleTrim: 'SVT', wheelTorque: '150'
  } });
  expect(customerResponse.ok(), await customerResponse.text()).toBeTruthy();
  const { id } = await customerResponse.json();
  const lead = await request.post('/api/widget/lead', { data: {
    tenantId: account.tenant, name: 'Returning Vehicle Customer', email: 'returning@example.invalid',
    phone: '+15125550182', vehicleYear: '2021', vehicleMake: 'Jeep', vehicleModel: 'Wrangler',
    vehicleTrim: 'Sport', message: 'Second vehicle visit', smsOptIn: false
  } });
  expect(lead.ok(), await lead.text()).toBeTruthy();
  const customers = await (await request.get('/api/customers', { headers })).json();
  const customer = customers.find((row: any) => row.id === id);
  expect(customer.vehicles).toHaveLength(2);
  expect(customer.vehicleModel).toBe('Raptor');
  const jeep = customer.vehicles.find((row: any) => row.vehicleMake === 'Jeep');
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const card = page.locator('.cards .card').filter({ hasText: 'Returning Vehicle Customer' });
  await expect(card).toContainText('2021 Jeep Wrangler');
  await card.getByRole('button', { name: 'Create Quote', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('vehicleId=' + jeep.id));
  await expect(page.getByLabel('Vehicle for this quote')).toHaveValue(jeep.id);
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  await next.click();
  await page.getByRole('button', { name: 'Add Labor Line' }).click();
  const fields = page.locator('.line-item-row .line-field');
  await fields.nth(0).fill('Second vehicle alignment');
  await fields.nth(1).fill('100');
  await next.click();
  await expect.poll(async () => {
    const result = await (await request.get('/api/service-documents', { headers })).json();
    return result.items.some((row: any) => row.document?.vehicleId === jeep.id && row.document?.vehicle?.includes('Jeep'));
  }).toBeTruthy();
  await page.goto('/customers');
  await page.getByRole('textbox', { name: 'Name, phone, email, year/make/model', exact: true }).fill('Jeep');
  await expect(page.locator('tbody tr').filter({ hasText: 'Returning Vehicle Customer' })).toHaveCount(1);
  await page.goto('/customers/' + id);
  const tabs = page.getByRole('tablist', { name: 'Customer vehicles' });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  const save = page.getByRole('button', { name: 'Save Customer', exact: true }).first();
  await expect(save).toBeDisabled();
  await tabs.getByRole('tab', { name: /2021 Jeep Wrangler/ }).click();
  await expect(save).toBeDisabled();
  await page.getByRole('textbox', { name: 'Trim', exact: true }).fill('Rubicon');
  await tabs.getByRole('tab', { name: /2013 Ford Raptor/ }).click();
  await expect(page.getByRole('textbox', { name: 'Trim', exact: true })).toHaveValue('SVT');
  await page.getByRole('textbox', { name: 'Trim', exact: true }).fill('SVT preserved');
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await tabs.getByRole('tab', { name: /2021 Jeep Wrangler/ }).click();
  await expect(page.getByRole('textbox', { name: 'Trim', exact: true })).toHaveValue('Rubicon');
  await page.getByRole('button', { name: 'Add vehicle', exact: true }).click();
  await page.getByRole('textbox', { name: 'Make', exact: true }).fill('Toyota');
  await page.getByRole('textbox', { name: 'Model', exact: true }).fill('Tacoma');
  await page.getByRole('textbox', { name: 'Year', exact: true }).fill('2024');
  await save.click();
  await expect(save).toBeDisabled();
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove Vehicle', exact: true }).click();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(tabs).toContainText('SVT preserved');
  await expect(tabs).toContainText('Rubicon');
  const today = new Date().toISOString().slice(0, 10);
  await page.route('**/api/schedule', route => route.fulfill({ json: [{ id: 'second-vehicle-appointment',
    customerId: id, vehicleId: jeep.id, vehicle: '2021 Jeep Wrangler Sport', resource: 'bay-1',
    start: today + 'T09:00:00', end: today + 'T11:00:00' }] }));
  await page.goto('/schedule');
  await expect(page.getByText('Returning Vehicle Customer — 2021 Jeep Wrangler Sport', { exact: true }).first()).toBeVisible();
});

test('a business reset clears cached quotes without uploading them again', async ({ page, request }) => {
  const account = await workspace(request);
  const headers = { 'x-tenant-id': account.tenant };
  const id = 'cached-quote-' + randomUUID();
  const seed = await request.post('/api/service-documents', { headers, data: {
    id, revision: null, document: { id, documentType: 'quote', invoiceNumber: 'QTE-CACHE-RESET',
      stage: 'draft', customerName: 'Old cached customer', total: 10, subtotal: 10, taxTotal: 0,
      lineItems: [], timeline: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  } });
  expect(seed.ok(), await seed.text()).toBeTruthy();
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const key = 'pathflow.invoices.v1.' + account.tenant;
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), key)).toContain(id);
  // Finish the original page's legitimate card creation before simulating a reset.
  await expect(page.locator('.cards .card').filter({ hasText: 'QTE-CACHE-RESET' })).toHaveCount(1);
  const uploads: string[] = [];
  const recreatedCards: string[] = [];
  await page.route('**/api/workitems', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    recreatedCards.push(route.request().postData() || '');
    return route.fulfill({ status: 409, json: { code: 'BUSINESS_DATA_RESET' } });
  });
  await page.route('**/api/service-documents', async route => {
    if (route.request().method() === 'GET') {
      // Let the board finish loading before the reset response arrives.
      await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({ json: { items: [], resetVersion: 'fresh-business-reset' } });
    }
    uploads.push(route.request().postData() || '');
    return route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), key)).not.toContain(id);
  expect(uploads.some(body => body.includes(id))).toBeFalsy();
  await expect(page.locator('.cards .card')).toHaveCount(0);
  expect(recreatedCards).toEqual([]);
});

test('dragging a paid invoice into Scheduled opens its appointment flow and moves only the saved job', async ({ page, request }) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  const account = await workspace(request);
  const headers = { 'x-tenant-id': account.tenant };
  async function post(path: string, data: object) {
    const response = await request.post('/api/' + path, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }
  const { id: customerId } = await post('customers', {
    name: 'Invoice Scheduling Customer', email: 'schedule-drag@example.invalid', phone: '+15125550128',
    vehicleYear: '2013', vehicleMake: 'Ford', vehicleModel: 'Raptor'
  });
  await post('settings', { key: 'schedule.settings', value: {
    openHour: 0, closeHour: 24, timeZone: 'America/Chicago', showWeekends: true,
    holidays: [], bays: [{ id: 'bay-1', name: 'Lift 1' }]
  } });
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('button', { name: 'Add to Scheduled', exact: true })).toBeVisible();
  const onboardingSaved = page.waitForResponse(response => response.url().endsWith('/api/settings')
    && response.request().method() === 'POST'
    && String(response.request().postDataJSON()?.key || '').endsWith('dashboard.onboarding.v1.completed'));
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  expect((await onboardingSaved).ok()).toBeTruthy();
  const olderId = randomUUID(), invoiceId = randomUUID();
  for (const [id, number, vehicle] of [[olderId, 'INV-SCHEDULE-OLDER', '2013 Ford Raptor'], [invoiceId, 'INV-SCHEDULE-NEW', '2024 Jeep Wrangler']]) {
    const invoiceData = { total: 200, subtotal: 200, taxTotal: 0, lineItems: [{ id: 'labor', type: 'labor',
      description: 'Installation', quantity: 2, unitPrice: 100, taxRate: 0, lineSubtotal: 200, taxAmount: 0, lineTotal: 200 }] };
    await post('service-documents', { id, document: { id, documentType: 'invoice', stage: 'sent', invoiceNumber: number,
      customerId, customerName: 'Invoice Scheduling Customer', vehicle, ...invoiceData, paidAmount: 0, timeline: [] } });
    await post('invoice-response', { op: 'publish-snapshot', invoiceId: id, invoiceNumber: number,
      publicToken: randomUUID(), customerName: 'Invoice Scheduling Customer', vehicle, amount: '200.00', invoiceData, paymentProvider: 'stripe' });
    await post('invoice-response', { op: 'record-manual-payment', action: 'pay', invoiceId: id,
      invoiceNumber: number, customerId, customerName: 'Invoice Scheduling Customer', paymentAmount: 200 });
  }
  const cards = await (await request.get('/api/workitems', { headers })).json();
  const olderJob = cards.find((card: any) => card.invoiceId === olderId), job = cards.find((card: any) => card.invoiceId === invoiceId);
  expect(job?.jobId).toBeTruthy();
  expect(olderJob?.jobId).toBeTruthy();
  const olderStart = new Date(Date.now() + 86400000).toISOString(), olderEnd = new Date(Date.now() + 90000000).toISOString();
  const oldAppointment = await post('schedule', { start: olderStart, end: olderEnd, resource: 'bay-1', customerId, workItemId: olderJob.id });
  await page.reload();
  const invoices = page.locator('.lane').filter({ has: page.getByRole('button', { name: 'Add to Invoices', exact: true }) });
  const scheduled = page.locator('.lane').filter({ has: page.getByRole('button', { name: 'Add to Scheduled', exact: true }) });
  const card = invoices.locator('.cards > .card').filter({ hasText: 'INV-SCHEDULE-NEW' });
  await expect(card.getByRole('button', { name: 'Schedule job', exact: true })).toBeVisible();
  const invoiceLaneId = await invoices.locator('.cards').getAttribute('id');
  const scheduledLaneId = await scheduled.locator('.cards').getAttribute('id');
  async function dropIntoScheduled() {
    const target = scheduled.locator('.cards');
    await target.scrollIntoViewIfNeeded();
    const from = await card.locator('.card-drag-handle').boundingBox(), to = await target.boundingBox();
    const x = from!.x + from!.width / 2, y = from!.y + from!.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 10, y + 3, { steps: 3 });
    await page.mouse.move(to!.x + to!.width / 2, to!.y + 60, { steps: 25 });
    await expect(target).toHaveClass(/cdk-drop-list-dragging/);
    await page.mouse.up();
  }
  const editor = page.getByRole('dialog', { name: 'Appointment', exact: true });
  await dropIntoScheduled();
  await expect(editor).toBeVisible();
  await expect(editor.locator('select[aria-label="Customer"] option:checked')).toHaveText('Invoice Scheduling Customer');
  await expect(page.locator('dialog[aria-label="Schedule"][open]')).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await editor.getByRole('button', { name: 'Close appointment', exact: true }).click();
  await page.getByRole('button', { name: 'Close schedule', exact: true }).click();
  await expect(card).toBeVisible();
  const afterCancel = await (await request.get('/api/workitems', { headers })).json();
  expect(afterCancel.find((item: any) => item.id === job.id).laneId).toBe(invoiceLaneId);
  expect((await (await request.get('/api/schedule', { headers })).json())).toHaveLength(1);

  await dropIntoScheduled();
  await expect(editor).toBeVisible();
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await editor.locator('input[type="datetime-local"]').nth(0).fill(day + 'T09:00');
  await editor.locator('input[type="datetime-local"]').nth(1).fill(day + 'T11:00');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/schedule') && response.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const savedResponse = await saved;
  expect(savedResponse.ok(), await savedResponse.text()).toBeTruthy();
  expect(savedResponse.request().postDataJSON()).toMatchObject({ customerId, workItemId: job.id, resource: 'bay-1' });
  await expect(editor).toBeHidden();
  await expect(scheduled.locator('.cards > .card').filter({ hasText: '2024 Jeep Wrangler' })).toBeVisible();
  await expect(card).toHaveCount(0);
  const appointments = await (await request.get('/api/schedule', { headers })).json();
  expect(appointments).toHaveLength(2);
  expect(appointments.find((item: any) => item.workItemId === job.id)).toMatchObject({ customerId, vehicle: '2024 Jeep Wrangler' });
  expect(appointments.find((item: any) => item.id === oldAppointment.id)).toMatchObject({ start: olderStart, end: olderEnd, workItemId: olderJob.id });
  const afterSave = await (await request.get('/api/workitems', { headers })).json();
  expect(afterSave.filter((item: any) => item.invoiceId === invoiceId)).toHaveLength(1);
  expect(afterSave.find((item: any) => item.id === job.id).laneId).toBe(scheduledLaneId);
});

test('draft invoices hide job and card-charge actions while issued invoices keep the appropriate actions', async ({ page, request }) => {
  const account = await workspace(request);
  const headers = { 'x-tenant-id': account.tenant };
  await page.route('**/api/settings?key=billing.paymentProviders', route => route.fulfill({ json: {
    ok: true, value: { defaultProvider: 'paylynx', providers: [
      { key: 'paylynx', label: 'PayLynx', connected: true, mode: 'test' }
    ] }
  } }));
  const stages = ['draft', 'sent', 'accepted', 'completed'] as const;
  const ids = new Map<string, string>();
  for (const stage of stages) {
    const id = randomUUID();
    ids.set(stage, id);
    const seeded = await request.post('/api/service-documents', { headers, data: { id, document: {
      id, documentType: 'invoice', stage, invoiceNumber: 'INV-ACTIONS-' + stage.toUpperCase(),
      customerName: 'Invoice Actions Customer', jobNumber: 'JOB-ACTIONS', subtotal: 200, taxTotal: 0,
      total: 200, paidAmount: ['accepted', 'completed'].includes(stage) ? 200 : 0,
      lineItems: [{ id: 'labor', type: 'labor', description: 'Installation', quantity: 2,
        unitPrice: 100, taxRate: 0, lineSubtotal: 200, taxAmount: 0, lineTotal: 200 }], timeline: []
    } } });
    expect(seeded.ok(), await seeded.text()).toBeTruthy();
  }
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  for (const stage of stages) {
    await page.goto('/invoices/' + ids.get(stage));
    await expect(page.locator('.stage-field select')).toHaveValue(stage);
    await expect(page.getByRole('button', { name: 'Open Job', exact: true })).toHaveCount(stage === 'draft' ? 0 : 2);
    if (stage === 'draft') {
      await expect(page.getByRole('button', { name: 'Send Invoice', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save Invoice', exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'More invoice actions', exact: true }).click();
    const charge = page.getByRole('button', { name: 'Charge Card', exact: true });
    if (stage === 'sent') await expect(charge).toBeEnabled();
    else await expect(charge).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Print Invoice', exact: true })).toBeVisible();
  }
});

test('dragging an accepted quote into Invoices opens its new invoice and send dialog without sending', async ({ page, request }) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  const account = await workspace(request);
  const headers = { 'x-tenant-id': account.tenant };
  const customer = await request.post('/api/customers', { headers, data: {
    name: 'Quote Drag Customer', email: 'quote-drag@example.invalid', phone: '+15125550127',
    vehicleYear: '2021', vehicleMake: 'Jeep', vehicleModel: 'Wrangler'
  } });
  expect(customer.ok(), await customer.text()).toBeTruthy();
  const { id: customerId } = await customer.json();
  const acceptedId = 'accepted-' + randomUUID(), pendingId = 'pending-' + randomUUID(), historicalId = randomUUID();
  for (const [id, documentType, stage, invoiceNumber] of [
    [acceptedId, 'quote', 'accepted', 'QTE-DRAG-ACCEPTED'],
    [pendingId, 'quote', 'sent', 'QTE-DRAG-PENDING'],
    [historicalId, 'invoice', 'accepted', 'INV-OLDER-PAID']
  ]) {
    const seeded = await request.post('/api/service-documents', { headers, data: { id, document: {
      id, documentType, stage, invoiceNumber, customerId, customerName: 'Quote Drag Customer',
      customerEmail: 'quote-drag@example.invalid', customerPhone: '+15125550127', vehicle: '2021 Jeep Wrangler',
      subtotal: 200, taxTotal: 0, total: 200, paidAmount: documentType === 'invoice' ? 200 : 0,
      lineItems: [{ id: 'quoted-labor', type: 'labor', description: 'Quoted installation', quantity: 2,
        unitPrice: 100, taxRate: 0, lineSubtotal: 200, taxAmount: 0, lineTotal: 200 }], timeline: []
    } } });
    expect(seeded.ok(), await seeded.text()).toBeTruthy();
  }
  const outbound: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST' || !/\/api\/(sms|email)$/.test(new URL(request.url()).pathname)) return;
    const body = request.postDataJSON();
    if (body?.message || body?.subject || body?.op === 'send') outbound.push(request.url());
  });
  await signIn(page, account.email, account.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const quotes = page.locator('.lane').filter({ has: page.getByRole('button', { name: 'Add to Quotes', exact: true }) });
  const invoices = page.locator('.lane').filter({ has: page.getByRole('button', { name: 'Add to Invoices', exact: true }) });
  const accepted = quotes.locator('.cards > .card').filter({ hasText: 'QTE-DRAG-ACCEPTED' });
  const pending = quotes.locator('.cards > .card').filter({ hasText: 'QTE-DRAG-PENDING' });
  await expect(accepted).toBeVisible();
  await expect(pending).toBeVisible();
  const invoiceLaneId = await invoices.locator('.cards').getAttribute('id');
  async function dragToInvoices(card: import('@playwright/test').Locator) {
    const target = invoices.locator('.cards');
    await target.scrollIntoViewIfNeeded();
    const from = await card.locator('.card-drag-handle').boundingBox(), to = await target.boundingBox();
    expect(from).not.toBeNull(); expect(to).not.toBeNull();
    const x = from!.x + from!.width / 2, y = from!.y + from!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 10, y + 3, { steps: 3 });
    await page.mouse.move(to!.x + to!.width / 2, to!.y + 60, { steps: 25 });
    await expect(target).toHaveClass(/cdk-drop-list-dragging/);
    await page.mouse.up();
  }
  await dragToInvoices(pending);
  await expect(page.getByText('The quote must be accepted before creating an invoice.', { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(pending).toBeVisible();
  const documents = async () => (await (await request.get('/api/service-documents', { headers })).json()).items.map((item: any) => item.document);
  expect((await documents()).filter((item: any) => item?.sourceQuoteId === pendingId)).toHaveLength(0);
  await dragToInvoices(accepted);
  const invoiceId = 'invoice-' + acceptedId;
  await expect(page).toHaveURL(new RegExp('/invoices/' + invoiceId + '(?:\\?|$)'));
  const send = page.getByRole('dialog').filter({ has: page.getByText('Select how to send this invoice:', { exact: true }) });
  await expect(send).toBeVisible();
  await expect(send).toContainText('$200.00');
  expect(outbound).toEqual([]);
  await expect.poll(async () => (await documents()).filter((item: any) => item?.sourceQuoteId === acceptedId).length).toBe(1);
  const saved = await documents();
  expect(saved.find((item: any) => item.id === invoiceId)).toMatchObject({ documentType: 'invoice', stage: 'draft', customerId, sourceQuoteId: acceptedId, paidAmount: 0 });
  expect(saved.find((item: any) => item.id === acceptedId).stage).toBe('accepted');
  expect(saved.find((item: any) => item.id === historicalId).paidAmount).toBe(200);
  await send.getByRole('button', { name: 'Close send invoice', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/dashboard');
  await expect(quotes.getByText('QTE-DRAG-ACCEPTED', { exact: false })).toHaveCount(0);
  const workitems = await (await request.get('/api/workitems', { headers })).json();
  const invoiceCards = workitems.filter((item: any) => item.title?.includes('[doc=' + invoiceId + ']'));
  expect(invoiceCards).toHaveLength(1);
  expect(invoiceCards[0].laneId).toBe(invoiceLaneId);
  expect(outbound).toEqual([]);
});
