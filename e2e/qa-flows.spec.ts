import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

function uniqueValue(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

type CustomerSeed = {
  id: string;
  name: string;
  displayName: string;
  email: string;
  phone: string;
};

type SentDocument = {
  id: string;
  number: string;
  customerName: string;
  customerEmail: string;
};

const QA_TENANT_ID = 'qa-automation';
const QA_EMAIL_DOMAIN = '@example.com';
const QA_TENANT_CLEANUP_IDS = [QA_TENANT_ID, 'primary-location', 'main', 'tenant-unassigned'];

async function seedAuthSession(
  page: Page,
  options?: { role?: 'admin' | 'user'; email?: string; displayName?: string; tenantId?: string }
): Promise<void> {
  const role = options?.role || 'admin';
  const email = options?.email || (role === 'admin' ? 'superadmin.local@yourcompany.dev' : 'user.local@yourcompany.dev');
  const displayName = options?.displayName || (role === 'admin' ? 'QA Super Admin' : 'QA User');
  const tenantId = options?.tenantId || QA_TENANT_ID;
  await page.addInitScript(({ seedRole, seedEmail, seedDisplayName, seedTenantId }) => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: seedRole,
      email: seedEmail,
      displayName: seedDisplayName
    }));
    localStorage.setItem('pathflow.tenant.id', seedTenantId);
  }, { seedRole: role, seedEmail: email, seedDisplayName: displayName, seedTenantId: tenantId });
}

async function createCustomerInUi(page: Page, namePrefix = 'Lead'): Promise<CustomerSeed> {
  const name = uniqueValue(namePrefix);
  const displayName = `QA ${name}`;
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.com`;
  const phoneTail = String(Date.now()).slice(-4);
  const phone = `(555) 01${phoneTail.slice(0, 2)}-${phoneTail.slice(2)}`;

  await page.goto('/customers/new');
  await expect(page.locator('ion-title', { hasText: 'New Customer' })).toBeVisible();

  await page.locator('ion-item', { hasText: 'First Name *' }).locator('input').fill('QA');
  await page.locator('ion-item', { hasText: 'Last Name *' }).locator('input').fill(name);
  await page.locator('ion-item', { hasText: 'Phone *' }).locator('input').fill(phone);
  await page.locator('ion-item', { hasText: 'Email *' }).locator('input').fill(email);

  await page.getByRole('button', { name: 'Save Customer' }).click();
  const saveAsSeparate = page.getByRole('button', { name: 'Save as Separate' });
  if (await saveAsSeparate.isVisible().catch(() => false)) {
    await saveAsSeparate.click();
  }

  await expect(page).toHaveURL(/\/customers\/(?!new(?:\?|$))[^/?#]+/);
  await expect(page.getByRole('heading', { name: displayName })).toBeVisible();

  const match = page.url().match(/\/customers\/([^/?#]+)/);
  const id = match?.[1] || '';

  return { id, name, displayName, email, phone };
}

async function assertCustomerNotVisibleInUi(page: Page, displayName: string): Promise<void> {
  await page.goto('/customers');
  await expect(page.locator('ion-title', { hasText: 'Customers' })).toBeVisible();
  await page.locator('ion-item.search-item ion-input input').fill(displayName);
  await expect(page.locator('tr.data-row', { hasText: displayName })).toHaveCount(0);
}

async function deleteCustomerInUi(page: Page, customerId: string): Promise<void> {
  await page.goto(`/customers/${encodeURIComponent(customerId)}`);
  await expect(page.getByRole('button', { name: 'Delete Customer' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Customer' }).click();
  const deleteModal = page.locator('ion-modal').filter({ has: page.locator('ion-title', { hasText: 'Delete Customer' }) }).last();
  await expect(deleteModal).toBeVisible();
  await deleteModal.getByRole('button', { name: 'Delete' }).click({ force: true });
  await expect(page).toHaveURL(/\/customers$/);
}

async function createScheduleAppointmentInUi(page: Page, customerId: string, noteText: string): Promise<void> {
  await page.goto(`/schedule?customerId=${encodeURIComponent(customerId)}`);
  await expect(page.locator('ion-title', { hasText: 'Appointment' })).toBeVisible();
  await page.locator('ion-item', { hasText: 'Notes' }).locator('textarea').fill(noteText);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Appointment saved.')).toBeVisible();
}

async function deleteScheduleAppointmentsForCustomer(request: APIRequestContext, customerId: string): Promise<void> {
  const tenantHeaders = { 'x-tenant-id': QA_TENANT_ID };
  const scheduleRes = await request.get('/api/schedule', { headers: tenantHeaders });
  const schedulePayload = scheduleRes.ok() ? await scheduleRes.json() : [];
  const scheduleItems = Array.isArray(schedulePayload) ? schedulePayload : [];
  const matchingIds = scheduleItems
    .filter((row: any) => String(row?.customerId || '').trim() === customerId)
    .map((row: any) => String(row?.id || '').trim())
    .filter(Boolean);

  for (const id of matchingIds) {
    await request.delete(`/api/schedule/${encodeURIComponent(id)}`, { headers: tenantHeaders });
  }
}

async function expectNoScheduleAppointmentsForCustomer(request: APIRequestContext, customerId: string): Promise<void> {
  const tenantHeaders = { 'x-tenant-id': QA_TENANT_ID };
  const scheduleRes = await request.get('/api/schedule', { headers: tenantHeaders });
  const schedulePayload = scheduleRes.ok() ? await scheduleRes.json() : [];
  const scheduleItems = Array.isArray(schedulePayload) ? schedulePayload : [];
  const remaining = scheduleItems.filter((row: any) => String(row?.customerId || '').trim() === customerId);
  expect(remaining).toHaveLength(0);
}

function isQaCustomerRecord(record: any): boolean {
  const name = String(record?.name || '').trim().toLowerCase();
  const email = String(record?.email || '').trim().toLowerCase();
  const secondaryEmail = String(record?.secondaryEmail || '').trim().toLowerCase();
  return name.startsWith('qa ') || email.endsWith(QA_EMAIL_DOMAIN) || secondaryEmail.endsWith(QA_EMAIL_DOMAIN);
}

function isQaScheduleRecord(record: any, qaCustomerIds: Set<string>): boolean {
  const customerId = String(record?.customerId || '').trim();
  if (customerId && qaCustomerIds.has(customerId)) return true;
  const title = String(record?.title || '').trim().toLowerCase();
  const notes = String(record?.notes || '').trim().toLowerCase();
  return title.includes('qa') || notes.includes('qa');
}

function isQaWorkItemRecord(record: any, qaCustomerIds: Set<string>): boolean {
  const customerId = String(record?.customerId || '').trim();
  if (customerId && qaCustomerIds.has(customerId)) return true;
  const title = String(record?.title || '').trim().toLowerCase();
  return title.startsWith('qa ');
}

async function cleanupQaArtifactsForTenant(request: APIRequestContext, tenantId: string): Promise<void> {
  const tenantHeaders = { 'x-tenant-id': tenantId };

  const customersRes = await request.get('/api/customers', { headers: tenantHeaders });
  const customersPayload = customersRes.ok() ? await customersRes.json() : [];
  const customers = Array.isArray(customersPayload)
    ? customersPayload
    : (Array.isArray(customersPayload?.items) ? customersPayload.items : []);
  const qaCustomers = customers.filter(isQaCustomerRecord);
  const qaCustomerIds = new Set<string>(qaCustomers.map((row: any) => String(row?.id || '').trim()).filter(Boolean));

  const scheduleRes = await request.get('/api/schedule', { headers: tenantHeaders });
  const schedulePayload = scheduleRes.ok() ? await scheduleRes.json() : [];
  const scheduleItems = Array.isArray(schedulePayload) ? schedulePayload : [];
  for (const row of scheduleItems) {
    if (!isQaScheduleRecord(row, qaCustomerIds)) continue;
    const id = String(row?.id || '').trim();
    if (!id) continue;
    await request.delete(`/api/schedule/${encodeURIComponent(id)}`, { headers: tenantHeaders });
  }

  const workItemsRes = await request.get('/api/workitems', { headers: tenantHeaders });
  const workItemsPayload = workItemsRes.ok() ? await workItemsRes.json() : [];
  const workItems = Array.isArray(workItemsPayload) ? workItemsPayload : [];
  for (const row of workItems) {
    if (!isQaWorkItemRecord(row, qaCustomerIds)) continue;
    const id = String(row?.id || '').trim();
    if (!id) continue;
    await request.delete(`/api/workitems/${encodeURIComponent(id)}`, { headers: tenantHeaders });
  }

  for (const row of qaCustomers) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    await request.post('/api/customers', {
      headers: tenantHeaders,
      data: { op: 'delete', id, tenantId }
    });
  }
}

async function cleanupQaArtifacts(request: APIRequestContext): Promise<void> {
  for (const tenantId of QA_TENANT_CLEANUP_IDS) {
    await cleanupQaArtifactsForTenant(request, tenantId);
  }
}

async function sendDocumentFromWizard(page: Page, type: 'quote' | 'invoice', customerDisplayName?: string): Promise<SentDocument> {
  const titleText = type === 'quote' ? 'Step 1: Add customer to quote' : 'Step 1: Add customer to invoice';
  const sendButtonText = type === 'quote' ? 'Send Quote' : 'Send Invoice';
  const detailPathRegex = type === 'quote' ? /\/quotes\// : /\/invoices\//;

  await page.goto(`/invoices/new?type=${type}`);
  await expect(page.getByText(titleText)).toBeVisible();

  if (customerDisplayName) {
    await page.getByLabel('Search customers').fill(customerDisplayName);
  }

  const option = customerDisplayName
    ? page.locator('.customer-option', { hasText: customerDisplayName }).first()
    : page.locator('.customer-option').first();
  await expect(option).toBeVisible();
  await option.click();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 2: Template')).toBeVisible();

  await page.getByRole('button', { name: '+ Add Labor Line' }).click();
  await expect(page.locator('.line-item-row').nth(1)).toBeVisible();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 3: Delivery channels')).toBeVisible();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 4: Notes')).toBeVisible();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 5: Review and send')).toBeVisible();

  await page.getByRole('button', { name: sendButtonText }).click();
  await expect(page).toHaveURL(detailPathRegex);

  const id = page.url().split('/').pop()?.split('?')[0] || '';
  const number = (await page.locator('.invoice-header-card h2').first().textContent() || '').trim();
  const customerName = (await page.locator('.invoice-meta span').first().textContent() || '').trim();

  expect(id).toBeTruthy();
  expect(number).toBeTruthy();

  return { id, number, customerName, customerEmail: '' };
}

async function assertDocumentVisibleInBoard(
  page: Page,
  options: { tab: 'quotes' | 'invoices'; documentNumber: string; customerName: string }
): Promise<void> {
  await page.goto('/quotes-invoices');
  await expect(page.locator('ion-title', { hasText: 'Quotes & Invoices' })).toBeVisible();
  if (options.tab === 'invoices') {
    await page.locator('ion-segment-button[value="invoices"]').click();
  } else {
    await page.locator('ion-segment-button[value="quotes"]').click();
  }

  await page.locator('#invoice-search').fill(options.documentNumber);
  const card = page.locator('.invoice-card', { hasText: options.documentNumber }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(options.customerName);
}

test.beforeEach(async ({ request }) => {
  await cleanupQaArtifacts(request);
});

test.afterEach(async ({ request }) => {
  await cleanupQaArtifacts(request);
});

test.afterAll(async ({ request }) => {
  await cleanupQaArtifacts(request);
});

test('login flow reaches dashboard', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Login as Super Admin' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.locator('ion-title', { hasText: 'Dashboard' })).toBeVisible();
});

test('core routes load', async ({ page }) => {
  await seedAuthSession(page);

  const checks: Array<{ route: string; title: string }> = [
    { route: '/dashboard', title: 'Dashboard' },
    { route: '/customers', title: 'Customers' },
    { route: '/schedule', title: 'Schedule' },
    { route: '/quotes-invoices', title: 'Quotes & Invoices' },
    { route: '/messages', title: 'Messages Hub' },
    { route: '/inventory', title: 'Inventory' },
    { route: '/reports', title: 'Reports' },
    { route: '/user-settings', title: 'User Settings' },
    { route: '/admin-settings', title: 'Admin Settings' }
  ];

  for (const check of checks) {
    await page.goto(check.route);
    await expect(page.locator('ion-title', { hasText: check.title })).toBeVisible();
  }
});

test('new customer can be created then deleted without remaining in the customer list', async ({ page }) => {
  await seedAuthSession(page);
  const customer = await createCustomerInUi(page, 'List Customer');

  await page.goto('/customers');
  await expect(page.locator('ion-title', { hasText: 'Customers' })).toBeVisible();
  await page.locator('ion-item.search-item ion-input input').fill(customer.displayName);

  const row = page.locator('tr.data-row', { hasText: customer.displayName }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(customer.email);

  await deleteCustomerInUi(page, customer.id);
  await assertCustomerNotVisibleInUi(page, customer.displayName);
});

test('calendar event can be added then removed and the QA customer can be deleted from the UI', async ({ page, request }) => {
  await seedAuthSession(page);
  const customer = await createCustomerInUi(page, 'Calendar Customer');
  const noteText = `QA calendar cleanup ${Date.now()}`;

  await createScheduleAppointmentInUi(page, customer.id, noteText);
  await deleteScheduleAppointmentsForCustomer(request, customer.id);
  await expectNoScheduleAppointmentsForCustomer(request, customer.id);
  await deleteCustomerInUi(page, customer.id);
  await assertCustomerNotVisibleInUi(page, customer.displayName);
});

test('customer profile supports SMS and Email actions', async ({ page }) => {
  await seedAuthSession(page);
  const customer = await createCustomerInUi(page, 'Comms Customer');
  const sendSmsButton = page.getByRole('button', { name: 'Send SMS' });

  await page.goto(`/customers/${encodeURIComponent(customer.id)}`);
  await page.locator('button[title="SMS History"]').click();
  await page.locator('.sms-compose-item textarea').first().fill(`QA SMS ${Date.now()}`);
  await expect(sendSmsButton).toBeEnabled();
  await sendSmsButton.click();

  await page.locator('button[title="Email History"]').click();
  const newEmailButton = page.getByRole('button', { name: 'New Email' });
  await expect(newEmailButton).toBeVisible();
  await newEmailButton.click();
});

test('quote can be sent and accepted from public link', async ({ page }) => {
  await seedAuthSession(page);
  const customer = await createCustomerInUi(page, 'Quote Customer');
  const quote = await sendDocumentFromWizard(page, 'quote', customer.displayName);
  await assertDocumentVisibleInBoard(page, {
    tab: 'quotes',
    documentNumber: quote.number,
    customerName: customer.displayName
  });

  const quoteAcceptedParams = new URLSearchParams({
    action: 'accept',
    quoteId: quote.id,
    tenantId: QA_TENANT_ID,
    quoteNumber: quote.number,
    customerName: quote.customerName || 'Customer',
    vehicle: '2022 Ford Bronco',
    businessName: 'Your Company'
  });

  await page.goto(`/quote-accepted?${quoteAcceptedParams.toString()}`);
  await expect(page.getByText('Quote Accepted')).toBeVisible();
  await expect(page.getByText('Quote status updated to Accepted.')).toBeVisible();
  await assertDocumentVisibleInBoard(page, {
    tab: 'quotes',
    documentNumber: quote.number,
    customerName: customer.displayName
  });
});

test('quote can be sent and declined from public link', async ({ page }) => {
  await seedAuthSession(page);
  const customer = await createCustomerInUi(page, 'Quote Decline');
  const quote = await sendDocumentFromWizard(page, 'quote', customer.displayName);
  await assertDocumentVisibleInBoard(page, {
    tab: 'quotes',
    documentNumber: quote.number,
    customerName: customer.displayName
  });

  const quoteDeclinedParams = new URLSearchParams({
    action: 'decline',
    quoteId: quote.id,
    tenantId: QA_TENANT_ID,
    quoteNumber: quote.number,
    customerName: quote.customerName || 'Customer',
    vehicle: '2022 Ford Bronco',
    businessName: 'Your Company'
  });

  await page.goto(`/quote-declined?${quoteDeclinedParams.toString()}`);
  await expect(page.getByText('Quote Declined')).toBeVisible();
  await expect(page.getByText('Quote status updated to Declined.')).toBeVisible();
  await assertDocumentVisibleInBoard(page, {
    tab: 'quotes',
    documentNumber: quote.number,
    customerName: customer.displayName
  });
});

test('invoice can be sent and then marked paid from public payment path', async ({ page }) => {
  await seedAuthSession(page);
  const customer = await createCustomerInUi(page, 'Invoice Customer');
  const invoice = await sendDocumentFromWizard(page, 'invoice', customer.displayName);
  await assertDocumentVisibleInBoard(page, {
    tab: 'invoices',
    documentNumber: invoice.number,
    customerName: customer.displayName
  });

  const paymentParams = new URLSearchParams({
    invoiceId: invoice.id,
    tenantId: QA_TENANT_ID,
    invoiceNumber: invoice.number,
    customerName: invoice.customerName || 'Customer',
    customerEmail: invoice.customerEmail || '',
    vehicle: '2022 Ford Bronco',
    businessName: 'Your Company',
    amount: '99999.00',
    dueDate: '2026-12-31',
    paymentUrl: 'https://example.com/pay',
    paymentProvider: 'mock'
  });

  await page.goto(`/invoice-payment?${paymentParams.toString()}`);
  await page.getByRole('button', { name: 'Checkout & Pay' }).click();
  await expect(page.getByText(/Payment received|Payment approved/i)).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Paid' })).toBeVisible();
  await assertDocumentVisibleInBoard(page, {
    tab: 'invoices',
    documentNumber: invoice.number,
    customerName: customer.displayName
  });
});

test('notifications panel opens from user menu', async ({ page }) => {
  await seedAuthSession(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);

  await page.getByRole('button', { name: 'Open notifications' }).click();
  await expect(page.getByText('Notifications', { exact: true })).toBeVisible();
});

test('feedback tab opens and validates required fields', async ({ page }) => {
  await seedAuthSession(page);
  await page.goto('/dashboard');

  await expect(page.locator('.feedback-tab')).toBeVisible();
  await page.locator('.feedback-tab').click();
  await expect(page.locator('.feedback-head h3', { hasText: 'Send Feedback' })).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Name, email, and issue details are required.')).toBeVisible();
});

test('login email-password validation appears and retry works with dev bypass', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Email' }).click();
  await expect(page.getByText('Email and password are required.')).toBeVisible();

  await page.getByRole('button', { name: 'Login as Super Admin' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test('non-admin cannot access admin settings', async ({ page }) => {
  await seedAuthSession(page, { role: 'user' });
  await page.goto('/admin-settings');
  await expect(page).toHaveURL(/\/forbidden/);
  await expect(page.getByText('Access denied')).toBeVisible();
});

test('schedule blocked bay requires block label', async ({ page }) => {
  await seedAuthSession(page);
  const customer = await createCustomerInUi(page, 'Schedule Validation');

  await page.goto(`/schedule?customerId=${encodeURIComponent(customer.id)}`);
  await expect(page.locator('ion-title', { hasText: 'Appointment' })).toBeVisible();
  await page.locator('ion-item', { hasText: 'Block bay' }).locator('ion-checkbox').click();
  await expect(page.getByText('Block label is required when blocking a bay.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('quote wizard blocks progress when no delivery channels are selected', async ({ page }) => {
  await seedAuthSession(page);
  const customer = await createCustomerInUi(page, 'Delivery Validation');

  await page.goto('/invoices/new?type=quote');
  await page.getByLabel('Search customers').fill(customer.displayName);
  await page.locator('.customer-option', { hasText: customer.displayName }).first().click();

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: '+ Add Labor Line' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 3: Delivery channels')).toBeVisible();

  await page.locator('label.channel-toggle', { hasText: 'Email' }).locator('input[type="checkbox"]').uncheck();
  await page.locator('label.channel-toggle', { hasText: 'SMS' }).locator('input[type="checkbox"]').uncheck();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
});

test('new customer save stays disabled until required contact fields are complete', async ({ page }) => {
  await seedAuthSession(page);
  await page.goto('/customers/new');
  await expect(page.locator('ion-title', { hasText: 'New Customer' })).toBeVisible();

  const saveButton = page.getByRole('button', { name: 'Save Customer' });
  await page.locator('ion-item', { hasText: 'Phone *' }).locator('input').fill('(555) 555-1212');
  await page.locator('ion-item', { hasText: 'Email *' }).locator('input').fill('qa@example.com');
  await expect(saveButton).toBeDisabled();

  await page.locator('ion-item', { hasText: 'First Name *' }).locator('input').fill('QA');
  await page.locator('ion-item', { hasText: 'Last Name *' }).locator('input').fill(`Required-${Date.now()}`);
  await expect(saveButton).toBeEnabled();
});

test('quote accepted public page handles missing quote id gracefully', async ({ page }) => {
  await page.goto('/quote-accepted?action=accept&tenantId=main&quoteNumber=QTE-TEST');
  await expect(page.getByText('Quote Accepted')).toBeVisible();
  await expect(page.getByText('Quote response captured.')).toBeVisible();
});

test('invoice payment page blocks checkout when invoice id is missing', async ({ page }) => {
  await page.goto('/invoice-payment?tenantId=main');
  await expect(page.getByText('Invoice is missing.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Checkout & Pay' })).toBeDisabled();
});
