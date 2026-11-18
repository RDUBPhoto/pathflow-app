import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function staffWorkspace(request: APIRequestContext, email = `shop-${randomUUID()}@example.test`, password = randomUUID()): Promise<string> {
  const signup = await request.post('/api/access', {
    data: { op: 'password-signup', email, password, displayName: 'Shop QA', phone: '5125550100' }
  });
  expect(signup.ok()).toBeTruthy();
  const setup = await request.post('/api/access', { data: { op: 'bootstrap', locations: ['Shop QA'] } });
  expect(setup.ok()).toBeTruthy();
  const profile = await setup.json();
  return profile.defaultLocationId || profile.tenantId || profile.profile?.defaultLocationId;
}

async function signInToDashboard(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[placeholder="you@company.com"]').fill(email);
  await page.locator('input[placeholder="Enter password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('a password session reaches the dashboard and survives reload', async ({ page, request }) => {
  const email = `browser-${randomUUID()}@example.test`;
  const password = randomUUID();
  await staffWorkspace(request, email, password);
  await signInToDashboard(page, email, password);
  await expect(page.getByText('Leads', { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('Leads', { exact: true }).first()).toBeVisible();
});

test('dashboard lanes give long customer and vehicle details room to wrap', async ({ page }) => {
  const customer = {
    id: 'long-card-customer',
    name: 'Alexandria Montgomery-Wellington Thompson III',
    vehicleYear: '2024',
    vehicleMake: 'Ford',
    vehicleModel: 'Super Duty F-450 Limited Crew Cab 4x4 with Long Bed'
  };
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'layout-qa@example.test', displayName: 'Layout QA'
    }));
  });
  await page.route('**/api/**', route => {
    const { pathname, search } = new URL(route.request().url());
    if (pathname === '/api/lanes') return route.fulfill({ json: [{ id: 'leads', name: 'Leads' }] });
    if (pathname === '/api/customers') return route.fulfill({ json: [customer] });
    if (pathname === '/api/workitems') {
      return route.fulfill({ json: [{ id: 'long-card', laneId: 'leads', customerId: customer.id }] });
    }
    if (pathname === '/api/schedule') return route.fulfill({ json: [] });
    if (pathname === '/api/settings' && search.includes('dashboard.onboarding')) {
      return route.fulfill({ json: { value: true } });
    }
    return route.fulfill({ json: { ok: true, items: [] } });
  });
  await page.goto('/dashboard');

  const lane = page.locator('.lane');
  await expect(lane).toHaveCSS('width', '330px');
  const fields = [
    lane.locator('.card-name-text').getByText(customer.name, { exact: true }),
    lane.getByText(`Vehicle: ${customer.vehicleYear} ${customer.vehicleMake} ${customer.vehicleModel}`)
  ];
  for (const field of fields) {
    await expect(field).toBeVisible();
    const wrapsInsideField = await field.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const lines = [...range.getClientRects()];
      const fieldWidth = element.getBoundingClientRect().width;
      return lines.length > 1 && lines.every(line => line.width <= fieldWidth + 1);
    });
    expect(wrapsInsideField).toBe(true);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const board = page.locator('.board');
  await expect.poll(() => lane.evaluate(element => element.clientWidth)).toBeLessThan(330);
  expect(await board.evaluate(element => element.scrollWidth)).toBe(await board.evaluate(element => element.clientWidth));
});

test('quotes and invoices fill the page and scroll when a lane grows', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'board-layout@example.test', displayName: 'Board Layout QA'
    }));
  });
  const invoiceCount = 16;
  const documents = Array.from({ length: invoiceCount + 1 }, (_, index) => {
    const id = `board-document-${index}`;
    const isQuote = index === 0;
    return {
      id,
      revision: '1',
      document: {
        id,
        documentType: isQuote ? 'quote' : 'invoice',
        stage: isQuote ? 'draft' : 'accepted',
        invoiceNumber: isQuote ? 'QTE-1000' : `INV-${1000 + index}`,
        customerName: `Layout Fixture ${index}`,
        vehicle: '2024 Ford Bronco',
        updatedAt: new Date().toISOString()
      }
    };
  });
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/service-documents') return route.fulfill({ json: { items: documents } });
    if (pathname === '/api/schedule') return route.fulfill({ json: [] });
    return route.fulfill({ json: { ok: true, items: [] } });
  });

  await page.goto('/quotes-invoices?tab=quotes');
  const content = page.locator('.invoices-content');
  const cards = content.locator('.invoice-card');
  await expect(cards).toHaveCount(1);
  const shortBoard = await content.evaluate(element => ({
    bottomGap: element.getBoundingClientRect().bottom - element.querySelector('.tabbed-panel')!.getBoundingClientRect().bottom,
    padding: parseFloat(getComputedStyle(element).paddingBottom),
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight
  }));
  expect(Math.abs(shortBoard.bottomGap - shortBoard.padding)).toBeLessThan(1);
  expect(shortBoard.scrollHeight).toBe(shortBoard.clientHeight);

  await page.getByRole('tab', { name: 'Invoices', exact: true }).click();
  await expect(cards).toHaveCount(invoiceCount);
  const paidLane = content.locator('.invoice-lane').filter({ has: page.getByText('Paid', { exact: true }) });
  const firstCard = paidLane.locator('.invoice-card').first();
  const lastCard = paidLane.locator('.invoice-card').last();
  expect(await paidLane.evaluate(element => element.clientHeight)).toBeGreaterThan(shortBoard.clientHeight);
  await firstCard.hover();
  await page.mouse.wheel(0, 5000);
  await expect(lastCard).toBeInViewport({ ratio: 1 });
  expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await paidLane.locator('.lane-cards').evaluate(element => element.scrollTop)).toBe(0);
});

test('customers scroll to the last row and pagination on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'customer-layout@example.test', displayName: 'Customer Layout QA'
    }));
  });
  const customers = Array.from({ length: 30 }, (_, index) => {
    const serial = String(index + 1).padStart(2, '0');
    return { id: `layout-customer-${serial}`, name: `Layout Customer ${serial}` };
  });
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const isCustomerList = pathname === '/api/customers' && route.request().method() === 'GET';
    return route.fulfill({ json: isCustomerList ? customers : { ok: true, items: [], total: 0 } });
  });
  await page.goto('/customers');

  const content = page.locator('.customers-content');
  const table = content.locator('.table-wrap');
  const pager = content.getByRole('button', { name: 'Next', exact: true });
  const lastRow = content.getByRole('row', { name: /Layout Customer 25/ });
  await expect(content.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  for (const viewport of [{ width: 1440, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await content.evaluate(element => { element.scrollTop = 0; });
    await table.hover({ position: { x: 80, y: 80 } });
    await page.mouse.wheel(0, 2000);
    await expect(pager).toBeInViewport({ ratio: 1 });
    await expect(lastRow).toBeInViewport();
    expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  }

  await pager.click();
  await expect(content.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  await expect(content.getByRole('cell', { name: 'Layout Customer 30', exact: true })).toBeVisible();
});

test('catalog and stock scroll to the last part and pagination', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'inventory-layout@example.test', displayName: 'Inventory Layout QA'
    }));
  });
  const parts = Array.from({ length: 40 }, (_, index) => {
    const serial = String(index + 1).padStart(2, '0');
    return { id: `layout-part-${serial}`, name: `Layout Part ${serial}`, sku: `SKU-${serial}` };
  });
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    return route.fulfill({ json: { ok: true, items: pathname === '/api/inventory' ? parts : [], needs: [], vendors: [] } });
  });

  for (const [section, width] of [['catalog', 1440], ['stock', 390]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/inventory?section=${section}`);
    const content = page.locator('.inventory-content');
    const table = content.locator('.inventory-table-wrap');
    const pager = content.getByRole('button', { name: 'Next', exact: true });
    await expect(content.getByText('Page 1 of 2', { exact: true })).toBeVisible();
    if (section === 'stock') {
      expect(await table.evaluate(element => element.scrollWidth)).toBeGreaterThan(await table.evaluate(element => element.clientWidth));
    }
    await table.hover({ position: { x: 80, y: 80 } });
    await page.mouse.wheel(0, 4000);
    await expect(pager).toBeInViewport({ ratio: 1 });
    await expect(table.getByRole('cell', { name: 'Layout Part 30', exact: true })).toBeInViewport();
    expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await pager.click();
    await expect(content.getByText('Page 2 of 2', { exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: 'Layout Part 40', exact: true })).toBeVisible();
  }
});

test('workspace pages keep overflowing settings and quote previews reachable', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'workspace-scroll@example.test', displayName: 'Workspace Scroll QA'
    }));
  });
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const list = ['/api/customers', '/api/schedule', '/api/lanes', '/api/workitems'].includes(pathname);
    return route.fulfill({ json: list ? [] : { ok: true, items: [], tasks: [], vendors: [] } });
  });

  await page.setViewportSize({ width: 1440, height: 540 });
  await page.goto('/admin-settings');
  const settings = page.locator('.admin-content');
  const saveProfile = settings.getByRole('button', { name: 'Save Business Profile' });
  const connectedApps = settings.getByRole('button', { name: /Connected Apps/ });
  await expect(saveProfile).toBeAttached();
  await settings.hover({ position: { x: 6, y: 80 } });
  await page.mouse.wheel(0, 2000);
  await expect(saveProfile).toBeInViewport();
  await expect(connectedApps).toBeInViewport();
  expect(await settings.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 540 });
  await page.goto('/invoices/new?type=quote');
  const wizard = page.locator('.invoices-new-content');
  const preview = wizard.getByRole('heading', { name: 'Quote Preview' });
  const previewOffset = await preview.evaluate(heading => {
    const content = heading.closest('.invoices-new-content')!;
    return heading.getBoundingClientRect().top - content.getBoundingClientRect().top;
  });
  await wizard.hover({ position: { x: 6, y: 80 } });
  await page.mouse.wheel(0, previewOffset - 100);
  await expect(preview).toBeInViewport();
  expect(await wizard.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test('messages scroll through conversations and reach the composer in a short mobile window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 390 });
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'messages-scroll@example.test', displayName: 'Messages Scroll QA'
    }));
  });
  const threads = Array.from({ length: 20 }, (_, index) => ({
    key: `thread-${index}`, customerId: `customer-${index}`, customerName: `Customer ${index + 1}`,
    customerPhone: '+12025550123', latestMessage: 'Fixture message', latestAt: '2026-01-01T12:00:00Z',
    latestDirection: 'inbound', unread: 0
  }));
  await page.route('**/api/**', route => {
    const { pathname, searchParams } = new URL(route.request().url());
    const items = pathname === '/api/sms' && searchParams.get('scope') === 'threads' ? threads : [];
    return route.fulfill({ json: { ok: true, items, tasks: [] } });
  });

  await page.goto('/messages');
  const conversations = page.locator('.threads-list');
  await expect(conversations.getByRole('button')).toHaveCount(20);
  await conversations.hover({ position: { x: 12, y: 12 } });
  await page.mouse.wheel(0, 2000);
  await expect(conversations.getByText('Customer 20', { exact: true })).toBeInViewport();

  const messages = page.locator('.messages-page');
  await messages.hover({ position: { x: 5, y: 80 } });
  await page.mouse.wheel(0, 2000);
  await expect(messages.getByRole('button', { name: 'Send SMS' })).toBeInViewport({ ratio: 1 });
});

test('Tabler controls support the dashboard and document board on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'tabler-qa@example.test', displayName: 'Tabler QA'
    }));
  });
  await page.route('**/api/settings?*dashboard.onboarding*', route => route.fulfill({ json: { value: true } }));
  const errors: Error[] = [];
  page.on('pageerror', error => errors.push(error));
  await page.goto('/dashboard');
  const addLead = page.getByRole('button', { name: 'Add to Leads', exact: true });
  await addLead.click();
  const dialog = page.getByRole('dialog', { name: 'Add to Leads' });
  await expect(dialog).toBeVisible();
  const customerSearch = dialog.getByRole('textbox', { name: 'Search customers' });
  await customerSearch.fill('Tabler QA');
  await expect(customerSearch).toHaveValue('Tabler QA');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(addLead).toBeFocused();

  const notifications = page.getByRole('button', { name: /notifications/i }).first();
  await notifications.click();
  await expect(page.getByRole('button', { name: 'Close notifications' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notifications).toBeFocused();

  const userMenu = page.getByRole('button', { name: 'User menu' });
  await userMenu.click();
  const theme = page.getByRole('switch', { name: 'Theme toggle' });
  await theme.check();
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  await page.keyboard.press('Escape');
  await expect(userMenu).toBeFocused();

  await page.goto('/quotes-invoices');
  const quotes = page.getByRole('tab', { name: 'Quotes', exact: true });
  const invoices = page.getByRole('tab', { name: 'Invoices', exact: true });
  await quotes.focus();
  await page.keyboard.press('ArrowRight');
  await expect(invoices).toHaveAttribute('aria-selected', 'true');
  await expect(invoices).toBeFocused();
  expect(errors).toEqual([]);
});

test.describe('shop time zone', () => {
  test.use({ timezoneId: 'Asia/Tokyo', locale: 'en-US' });

  test('the picker saves the zone and Calendar uses it for today and appointment emails', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-10T01:30:00Z'));
    await page.addInitScript(() => {
      localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
        role: 'admin', email: 'shop-time-qa@example.test', displayName: 'Shop Time QA'
      }));
    });
    let settingsWrites = 0;
    let settings = {
      timeZone: 'US/Central', openHour: 7, closeHour: 16, showWeekends: false,
      bays: [{ id: 'bay-1', name: 'Main Lift' }], holidays: [], federalInitialized: true
    };
    const customer = { id: 'shop-time-customer', name: 'Time Zone Fixture', email: 'customer@example.test' };
    let appointment = {
      id: 'shop-time-appointment', customerId: customer.id, resource: 'bay-1', notes: '',
      start: '2026-11-09T09:00:00', end: '2026-11-09T11:00:00'
    };
    let sentEmail = '';
    await page.route('**/api/**', route => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      const post = request.method() === 'POST' ? request.postDataJSON() : null;
      if (pathname === '/api/settings') {
        if (post?.key === 'schedule.settings') {
          settingsWrites++;
          settings = post.value;
        }
        if (searchParams.get('key') === 'schedule.settings' || post?.key === 'schedule.settings') {
          return route.fulfill({ json: { ok: true, value: settings } });
        }
      }
      if (pathname === '/api/customers') return route.fulfill({ json: [customer] });
      if (pathname === '/api/schedule') {
        if (!post) return route.fulfill({ json: [appointment] });
        appointment = { ...appointment, ...post };
        return route.fulfill({ json: { ok: true, id: appointment.id } });
      }
      if (pathname === '/api/email' && post?.message) sentEmail = post.message;
      return route.fulfill({ json: { ok: true, items: [], tasks: [], users: [], vendors: [] } });
    });

    await page.goto('/admin-settings');
    await page.getByRole('button', { name: /^Schedule Business hours/ }).click();
    const picker = page.getByLabel('Shop time zone', { exact: true });
    await expect(picker).toHaveValue('US/Central');
    expect(await picker.locator('option').count()).toBeGreaterThan(100);
    await picker.selectOption('America/Los_Angeles');
    await page.getByRole('button', { name: 'Save schedule settings', exact: true }).click();
    await expect(page.getByText('Schedule settings saved.', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: /^Schedule Business hours/ }).click();
    await expect(picker).toHaveValue('America/Los_Angeles');

    await page.goto('/schedule');
    await expect(page.locator('.calendar-range-label')).toHaveText('Monday, Nov 9, 2026 · America/Los_Angeles');
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    const event = page.locator('.evt-content').filter({ hasText: 'Time Zone Fixture' });
    await expect(event).toContainText('9:00 AM–11:00 AM');
    await event.click();
    const editor = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(editor.locator('input[aria-label="Start"]')).toHaveValue('2026-11-09T09:00');
    await editor.locator('input[aria-label="End"]').fill('2026-11-09T12:00');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    const sendDialog = page.getByRole('dialog', { name: 'Send Scheduled Info', exact: true });
    await expect(sendDialog).toContainText('9:00 AM PST');
    await sendDialog.getByRole('button', { name: 'Send Info', exact: true }).click();
    await expect.poll(() => sentEmail).toContain('20261109T170000Z%2F20261109T200000Z');
    expect(sentEmail).toContain('startdt=2026-11-09T17%3A00%3A00.000Z');

    await page.goto(`/schedule?customerId=${customer.id}`);
    await expect(editor.locator('input[aria-label="Start"]')).toHaveValue('2026-11-10T07:00');
    expect(settingsWrites).toBe(1);
  });

  test('calendar opens each saved view on the current shop date instead of the last browsed date', async ({ page }) => {
    // At this instant the browser is already on Sunday, but the shop is still on Saturday.
    await page.clock.setFixedTime(new Date('2026-11-08T02:30:00Z'));
    await page.addInitScript(() => {
      localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
        role: 'admin', email: 'calendar-today@example.test', displayName: 'Calendar Today QA'
      }));
    });
    let savedView = 'day';
    let dateRequests = 0;
    await page.route('**/api/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      const setting = url.searchParams.get('key') ?? (request.method() === 'POST' ? request.postDataJSON()?.key : '') ?? '';
      if (setting.toLowerCase().endsWith('schedule.viewstart')) {
        dateRequests++;
        return route.fulfill({ json: { value: '2026-07-01' } });
      }
      if (setting.toLowerCase().endsWith('schedule.viewmode')) return route.fulfill({ json: { value: savedView } });
      if (setting === 'schedule.settings') {
        return route.fulfill({ json: { value: { timeZone: 'America/Los_Angeles', showWeekends: false } } });
      }
      if (url.pathname === '/api/schedule' || url.pathname === '/api/customers') return route.fulfill({ json: [] });
      return route.fulfill({ json: { items: [] } });
    });

    const range = page.locator('.calendar-range-label');
    for (const [view, label] of [
      ['Day', 'Saturday, Nov 7, 2026'],
      ['Week', 'Nov 2 - Nov 8, 2026'],
      ['Month', 'November 2026']
    ]) {
      savedView = view.toLowerCase();
      await page.goto('/schedule');
      const expectedRange = `${label} · America/Los_Angeles`;
      await expect(page.getByRole('button', { name: view, exact: true })).toHaveClass(/\bactive\b/);
      await expect(range).toHaveText(expectedRange);
      if (view === 'Week') {
        await expect(page.locator('.scheduler_default_main').getByText('Sa 7', { exact: true })).toBeInViewport();
      }
      if (view === 'Month') {
        await expect(page.locator('.month-shell [aria-current="date"]')).toHaveText('7');
      }

      await page.getByRole('button', { name: 'Prev', exact: true }).click();
      await expect(range).not.toHaveText(expectedRange);
      await page.getByRole('button', { name: 'Today', exact: true }).click();
      await expect(range).toHaveText(expectedRange);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(range).not.toHaveText(expectedRange);
      await page.reload();
      await expect(range).toHaveText(expectedRange);
    }
    expect(dateRequests).toBe(0);
  });
});

async function stubPaylynxCardFields(page: import('@playwright/test').Page, mode: 'test' | 'live' = 'test') {
  const host = mode === 'live' ? 'tokenization.paylynxgateway.com' : 'tokenization.sandbox.paylynxgateway.com';
  await page.route(`https://${host}/tokenization/v0.3`, route =>
    route.fulfill({ contentType: 'text/javascript', body: `
      window.HostedTokenization = class {
        constructor(key, options) {
          if (key !== 'pk_fixture') throw new Error('Unexpected tokenization key');
          options.target.textContent = 'Hosted test card fields';
        }
        on(event, callback) { if (event === 'ready') setTimeout(callback, 0); }
        setStyles() {}
        async getNonceToken() {
          return { nonce: 'TestNonce', expiryMonth: 12, expiryYear: 2030, avsZip: '78130' };
        }
        destroy() {}
      };
    ` })
  );
}

for (const mode of ['test', 'live'] as const) {
test(`PayLynx ${mode} checkout loads matching hosted fields and waits for confirmation`, async ({ page }) => {
  await stubPaylynxCardFields(page, mode);
  await page.route('**/api/**', route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/invoice-response') {
      return route.fulfill({ json: { ok: true, item: {
        invoiceNumber: 'INV-PAYLYNX', customerName: 'Fixture Customer', businessName: 'Fixture Shop',
        amount: '125.00', paidAmount: 0, invoiceData: { total: 125 }, paymentProvider: 'paylynx'
      } } });
    }
    if (pathname === '/api/payment-charge') {
      if (request.method() === 'GET') return route.fulfill({ json: { ok: true, tokenizationKey: 'pk_fixture', mode } });
      expect(request.postDataJSON()).toEqual({
        invoiceId: 'fixture-invoice', publicToken: 'fixture-token', tenantId: 'primary-location',
        amount: '125.00', source: 'nonce-TestNonce', expiryMonth: 12, expiryYear: 2030, billingZip: '78130'
      });
      return route.fulfill({ json: { ok: true, provider: 'paylynx', mode, transactionId: '83001', receiptSent: false } });
    }
    return route.fulfill({ json: { ok: true, items: [] } });
  });
  await page.goto('/invoice-payment?invoiceId=fixture-invoice&publicToken=fixture-token&tenantId=primary-location');
  await expect(page.getByText('Hosted test card fields')).toBeVisible();
  await expect(page.getByText('Sandbox · Test cards only', { exact: true })).toHaveCount(mode === 'test' ? 1 : 0);
  await expect(page.getByRole('heading', { name: 'Your invoice is paid' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pay Invoice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your invoice is paid' })).toBeVisible();
});
}

for (const scenario of ['void', 'refund'] as const) {
  test(`a PayLynx ${scenario} records the selected invoice treatment`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
        role: 'admin', email: 'payments-qa@example.test', displayName: 'Payments QA'
      }));
    });
    const invoiceId = 'paylynx-invoice-fixture';
    const amount = scenario === 'void' ? 1 : 0.97;
    const creditInvoice = scenario === 'refund';
    let reversed = false;
    await page.route('**/api/**', route => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === '/api/service-documents') {
        return route.fulfill({ json: { items: [{
          id: invoiceId, revision: 'fixture', document: {
            id: invoiceId, documentType: 'invoice', invoiceNumber: 'INV-PAYLYNX-VOID',
            stage: reversed && !creditInvoice ? 'sent' : 'accepted',
            total: reversed && creditInvoice ? 0.03 : 1, paidAmount: reversed ? 1 - amount : 1,
            returnCreditAmount: reversed && creditInvoice ? amount : 0,
            lineItems: [{ id: 'item', type: 'labor', description: 'Sandbox test', quantity: 1, unitPrice: 1 }],
            paymentTransactions: [{ provider: 'paylynx', transactionId: '83001', amount: 1, createdAt: '2026-11-16T13:00:00Z' }],
            refundTransactions: reversed ? [{
              id: 'reversal-83001', provider: 'paylynx', amount, transactionId: 'reversal-83001',
              originalTransactionId: '83001', operation: scenario, createdAt: '2026-11-16T13:01:00Z',
              creditInvoice, retainedFee: creditInvoice ? 0.03 : 0
            }] : []
          }
        }] } });
      }
      if (pathname === '/api/payment-refund') {
        if (request.method() === 'GET') return route.fulfill({ json: {
          operation: scenario, originalAmount: 1, refundableAmount: 1, invoiceTotal: 1, alreadyReversed: 0
        } });
        expect(request.postDataJSON()).toMatchObject({
          invoiceId, provider: 'paylynx', originalTransactionId: '83001', amount: amount.toFixed(2), alreadyReversed: 0,
          expectedOperation: scenario, creditInvoice, retainedFee: creditInvoice ? 0.03 : 0
        });
        reversed = true;
        return route.fulfill({ json: {
          ok: true, provider: 'paylynx', originalTransactionId: '83001', refundTransactionId: 'reversal-83001',
          operation: scenario, paidAmount: 1 - amount, returnCreditAmount: creditInvoice ? amount : 0,
          reversal: { id: 'reversal-83001', createdAt: '2026-11-16T13:01:00Z' }
        } });
      }
      return route.fulfill({ json: pathname === '/api/schedule' || pathname === '/api/customers' ? [] : { ok: true, items: [] } });
    });
    await page.goto(`/invoices/${invoiceId}`);
    await expect(page.getByRole('heading', { name: 'INV-PAYLYNX-VOID' })).toBeVisible();
    const stage = page.getByRole('combobox', { name: 'Stage', exact: true });
    await expect(stage).toHaveValue('accepted');
    await page.getByRole('button', { name: 'More invoice actions' }).click();
    await page.getByRole('button', { name: 'Return or void payment 83001' }).click();
    if (creditInvoice) {
      await page.getByLabel('Invoice treatment').selectOption('credit');
      await page.getByLabel('Card fee to retain (optional)').fill('0.03');
      await expect(page.getByRole('button', { name: 'Confirm Refund' })).toBeDisabled();
      await page.getByLabel('Reason for return (required)').fill('Returned parts');
      await expect(page.getByText('Customer receives').locator('..')).toContainText('$0.97');
      await page.getByRole('button', { name: 'Confirm Refund' }).click();
      await expect(page.getByText('Refunded $0.97 through PayLynx. Invoice credited.')).toBeVisible();
    } else {
      await expect(page.getByText('PayLynx can void the full', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: 'Confirm Void' }).click();
      await expect(page.getByText('Voided $1.00 through PayLynx.')).toBeVisible();
    }
    await expect(stage).toHaveValue(creditInvoice ? 'accepted' : 'sent');

    await page.reload();
    await expect(stage).toHaveValue(creditInvoice ? 'accepted' : 'sent');
    if (creditInvoice) await expect(page.getByText('Return Credit', { exact: true })).toBeVisible();
  });
}

test('manual PayLynx card entry explains declines and blocks retries for an unconfirmed charge', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'payments-qa@example.test', displayName: 'Payments QA'
    }));
  });
  await stubPaylynxCardFields(page);
  let submissions = 0;
  await page.route('**/api/**', route => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    if (pathname === '/api/payment-charge') {
      if (request.method() === 'GET') {
        expect(searchParams.get('staffCharge')).toBe('true');
        expect(searchParams.has('publicToken')).toBe(false);
        return route.fulfill({ json: {
          invoiceNumber: 'INV-STAFF-CARD', paymentProvider: 'paylynx', amount: 125, paidAmount: 0,
          invoiceData: { total: 125 }, tokenizationKey: 'pk_fixture', paymentPending: submissions > 1
        } });
      }
      expect(request.postDataJSON()).toEqual({
        staffCharge: true, invoiceId: 'staff-invoice', tenantId: 'primary-location', amount: '125.00', source: 'nonce-TestNonce',
        expiryMonth: 12, expiryYear: 2030, billingZip: '78130'
      });
      submissions++;
      return submissions === 1
        ? route.fulfill({ status: 400, json: { code: 'security_code', error: 'The security code did not match. Check the card and try again.' } })
        : route.fulfill({ status: 409, json: { code: 'payment_pending' } });
    }
    return route.fulfill({ json: pathname === '/api/schedule' || pathname === '/api/customers' ? [] : { ok: true, items: [] } });
  });
  await page.goto('/invoices/staff-invoice/charge?tenantId=primary-location');
  const charge = page.getByRole('button', { name: 'Charge $125.00' });
  await charge.click();
  await expect(page.getByRole('alert')).toHaveText('The security code did not match. Check the card and try again.');
  await expect(charge).toBeEnabled();
  await charge.click();
  await expect(page.getByRole('alert')).toContainText('Payment is awaiting confirmation');
  await expect(charge).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Payment is awaiting confirmation');
  await expect(charge).toBeDisabled();
  expect(submissions).toBe(2);
});

test('day and week calendars keep their height and the page scrolls in a short window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 920 });
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'calendar-layout@example.test', displayName: 'Calendar Layout QA'
    }));
  });
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    return route.fulfill({ json: pathname === '/api/schedule' || pathname === '/api/customers' ? [] : { items: [] } });
  });
  await page.goto('/schedule');

  const content = page.locator('.schedule-content');
  const grid = page.locator('.scheduler_default_main');
  const timeline = grid.locator('.scheduler_default_scrollable');
  await expect(timeline).toBeVisible();
  const gridHeight = await grid.evaluate(element => element.getBoundingClientRect().height);
  expect(await timeline.evaluate(element => element.clientHeight)).toBe(500);
  expect(await content.evaluate(element => element.scrollHeight)).toBe(await content.evaluate(element => element.clientHeight));

  await page.setViewportSize({ width: 1280, height: 540 });
  for (const view of ['Day', 'Week']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(grid).toBeVisible();
    expect(await grid.evaluate(element => element.getBoundingClientRect().height)).toBe(gridHeight);
    await timeline.hover({ position: { x: 60, y: 80 } });
    await page.mouse.wheel(0, 800);
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(grid.getByText('Four-Post Lift', { exact: true })).toBeInViewport();
    expect(await timeline.evaluate(element => element.scrollTop)).toBe(0);
  }
});

test('month calendar fills the page and grows for a busy week', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.clock.setFixedTime(new Date('2026-07-15T17:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'month-layout@example.test', displayName: 'Month Layout QA'
    }));
  });
  const busyDay = Array.from({ length: 30 }, (_, index) => ({
    id: `month-event-${index}`,
    resource: 'bay-1',
    start: '2026-08-30T09:00:00',
    end: '2026-08-30T10:00:00',
    isBlocked: true,
    title: `Layout fixture ${index + 1}`
  }));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const setting = url.searchParams.get('key')?.toLowerCase() || '';
    if (setting.endsWith('schedule.viewmode')) return route.fulfill({ json: { value: 'month' } });
    if (url.pathname === '/api/schedule') return route.fulfill({ json: busyDay });
    if (url.pathname === '/api/customers') return route.fulfill({ json: [] });
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto('/schedule');
  await expect(page.locator('.calendar-toolbar-center')).toHaveText('July 2026');
  const content = page.locator('.schedule-content');
  const month = content.locator('.month-shell');
  const grid = month.locator('.month_default_main');
  await expect(grid).toBeVisible();
  await expect.poll(() => content.evaluate(element => {
    const bottom = element.getBoundingClientRect().bottom;
    const panelBottom = element.querySelector('.schedule-shell')!.getBoundingClientRect().bottom;
    const padding = parseFloat(getComputedStyle(element).paddingBottom);
    return Math.abs(bottom - panelBottom - padding);
  })).toBeLessThan(2);
  await expect.poll(() => month.evaluate(element =>
    element.getBoundingClientRect().bottom - element.querySelector('.month_default_main')!.getBoundingClientRect().bottom
  )).toBeLessThan(8);

  await page.setViewportSize({ width: 1440, height: 540 });
  await expect.poll(() => content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  await grid.hover({ position: { x: 120, y: 80 } });
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(grid.locator('.month_default_cell').last()).toBeInViewport();

  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.calendar-toolbar-center')).toHaveText('August 2026');
  const events = grid.locator('.month_default_event');
  await expect(events).toHaveCount(busyDay.length);
  await expect.poll(() => content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
  await grid.hover({ position: { x: 120, y: 80 } });
  await page.mouse.wheel(0, 2000);
  await expect(events.last()).toBeInViewport({ ratio: 1 });
  expect(await month.evaluate(element => element.scrollTop)).toBe(0);
});

test('the Tabler appointment editor supports selecting a bay and blocking it', async ({ page }) => {
  const email = 'calendar-ui@example.test';
  await page.addInitScript(devEmail => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: devEmail, displayName: 'Calendar QA'
    }));
  }, email);
  const customer = await page.request.post('/api/customers', {
    headers: {
      'x-tenant-id': 'primary-location',
      'x-dev-user-email': email,
      'x-dev-user-roles': 'authenticated,admin'
    },
    data: { name: 'Calendar Fixture', firstName: 'Calendar', lastName: 'Fixture', email: 'fixture@example.test' }
  });
  expect(customer.ok(), await customer.text()).toBeTruthy();
  const { id } = await customer.json();
  await page.goto(`/schedule?customerId=${encodeURIComponent(id)}&autoOpen=0`);
  await page.getByRole('button', { name: 'Pick manually' }).click();
  const editor = page.getByRole('dialog', { name: 'Appointment', exact: true });
  await expect(editor.getByRole('combobox', { name: 'Customer' })).toHaveValue(new RegExp(id));
  const bays = editor.getByRole('combobox', { name: 'Lift / Bay (Category)' });
  await expect(bays.locator('option').first()).toBeAttached();
  await bays.selectOption({ index: 0 });
  await editor.getByRole('checkbox', { name: 'Block bay' }).check();
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await editor.getByRole('textbox', { name: 'Block label' }).fill('Lift inspection');
  await expect(editor.getByRole('textbox', { name: 'Block label' })).toHaveValue('Lift inspection');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeHidden();
});

test('quote decision reaches the shared document and one staff notification', async ({ page, request }) => {
  const tenant = await staffWorkspace(request);
  expect(tenant).toBeTruthy();
  const headers = { 'x-tenant-id': tenant };
  const quoteId = randomUUID();
  const token = randomUUID();
  const document = { id: quoteId, documentType: 'quote', stage: 'sent', invoiceNumber: 'QTE-QA', customerName: 'Synthetic Customer' };
  const shared = await request.post('/api/service-documents', { headers, data: { id: quoteId, document } });
  expect(shared.ok()).toBeTruthy();
  const { revision } = await shared.json();
  const latest = await request.post('/api/service-documents', { headers, data: {
    id: quoteId, revision, document: { ...document, customerNote: 'Current revision' }
  } });
  expect(latest.ok()).toBeTruthy();
  const stale = await request.post('/api/service-documents', { headers, data: {
    id: quoteId, revision, document: { ...document, customerNote: 'Older session' }
  } });
  expect(stale.status()).toBe(409);
  const snapshot = await request.post('/api/quote-response', { headers, data: {
    op: 'publish-snapshot', quoteId, publicToken: token, quoteNumber: 'QTE-QA',
    quoteData: { quoteId, quoteNumber: 'QTE-QA', customerName: 'Synthetic Customer', total: 125 }
  } });
  expect(snapshot.ok()).toBeTruthy();
  const query = new URLSearchParams({ quoteId, tenantId: tenant, publicToken: token });
  await page.goto(`/quote-response?${query}`);
  await page.getByRole('button', { name: 'Accept Quote' }).click();
  await expect.poll(async () => {
    const response = await request.get('/api/service-documents', { headers });
    const { items } = await response.json();
    return items.find((row: { id: string }) => row.id === quoteId)?.document?.stage;
  }).toBe('accepted');
  const notifications = await request.get('/api/notifications?scope=all', { headers });
  const feed = await notifications.json();
  expect(feed.items.filter((item: { entityId: string }) => item.entityId === quoteId)).toHaveLength(1);
});

test('a scheduled job does not bring its converted quote back to the dashboard', async ({ page }) => {
  const email = `scheduled-quote-${randomUUID()}@example.test`;
  const password = randomUUID();
  const tenant = await staffWorkspace(page.request, email, password);
  const headers = { 'x-tenant-id': tenant };
  const customerName = 'Scheduled Quote Fixture';
  async function post(path: string, data: object) {
    const response = await page.request.post(`/api/${path}`, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }
  const { id: customerId } = await post('customers', { name: customerName });
  const lanesResponse = await page.request.get('/api/lanes', { headers });
  const lanes = await lanesResponse.json() as Array<{ id: string; stageKey: string }>;
  const quoteLaneId = lanes.find(lane => lane.stageKey === 'quote')!.id;
  const quoteId = randomUUID();
  const invoiceId = randomUUID();
  const otherQuoteId = randomUUID();
  await post('service-documents', { id: quoteId, document: {
    id: quoteId, documentType: 'quote', stage: 'accepted', customerId, customerName, invoiceNumber: 'QTE-SCHEDULED'
  } });
  await post('service-documents', { id: otherQuoteId, document: {
    id: otherQuoteId, documentType: 'quote', stage: 'sent', customerId, customerName, invoiceNumber: 'QTE-OTHER'
  } });
  await post('service-documents', { id: invoiceId, document: {
    id: invoiceId, documentType: 'invoice', stage: 'accepted', sourceQuoteId: quoteId,
    customerId, customerName, invoiceNumber: 'INV-SCHEDULED', paidAmount: 100, total: 100
  } });
  await post('invoice-response', {
    op: 'record-manual-payment', action: 'pay', invoiceId, invoiceNumber: 'INV-SCHEDULED',
    customerId, customerName, paymentAmount: 100
  });
  const workItems = async (): Promise<Array<{ id: string; invoiceId?: string; title: string; laneId: string }>> => {
    const response = await page.request.get('/api/workitems', { headers });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const job = (await workItems()).find(item => item.invoiceId === invoiceId);
  expect(job).toBeTruthy();
  await post('settings', { op: 'set', key: 'schedule.settings', value: {
    openHour: 0, closeHour: 24, timeZone: 'America/Chicago', showWeekends: true
  } });
  await post('schedule', {
    start: new Date(Date.now() + 3600000).toISOString(), end: new Date(Date.now() + 7200000).toISOString(),
    resource: 'bay-1', customerId, workItemId: job!.id
  });
  const stale = await post('workitems', {
    title: `Previously created quote [doc=${quoteId}]`, laneId: quoteLaneId, customerId
  });
  const other = await post('workitems', {
    title: `Different quote [doc=${otherQuoteId}]`, laneId: quoteLaneId, customerId
  });

  await signInToDashboard(page, email, password);
  const quotes = page.locator('.lane').filter({ has: page.getByRole('button', { name: 'Add to Quotes', exact: true }) });
  const scheduled = page.locator('.lane').filter({ has: page.getByRole('button', { name: 'Add to Scheduled', exact: true }) });
  await expect(scheduled.getByText(customerName, { exact: true })).toHaveCount(1);
  await expect(quotes.getByRole('button', { name: 'Quote: QTE-OTHER' })).toBeVisible();
  await expect(quotes.getByRole('button', { name: 'Quote: QTE-SCHEDULED' })).toHaveCount(0);

  for (const id of [stale.id, other.id]) {
    const removed = await page.request.delete(`/api/workitems/${id}`, { headers });
    expect(removed.ok()).toBeTruthy();
  }
  // Revisit with documents already loaded to exercise dashboard card rebuilding.
  await page.getByRole('link', { name: 'Quotes & Invoices', exact: true }).click();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(scheduled.getByText(customerName, { exact: true })).toHaveCount(1);
  await expect(quotes.getByRole('button', { name: 'Quote: QTE-OTHER' })).toBeVisible();
  expect((await workItems()).filter(item => item.laneId === quoteLaneId && item.title.includes(`[doc=${quoteId}]`))).toHaveLength(0);
});

test('the invoice lane creates and opens the correct invoice for a returning customer', async ({ page }) => {
  const email = `invoice-lane-${randomUUID()}@example.test`;
  const password = randomUUID();
  const tenant = await staffWorkspace(page.request, email, password);
  const headers = { 'x-tenant-id': tenant };
  const customerName = 'Returning Invoice Customer';
  async function post(path: string, data: object) {
    const response = await page.request.post(`/api/${path}`, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }

  const { id: customerId } = await post('customers', { name: customerName, vehicleMake: 'Jeep' });
  const lanes = await (await page.request.get('/api/lanes', { headers })).json();
  const invoiceLaneId = lanes.find((lane: { stageKey: string }) => lane.stageKey === 'invoiced').id;
  const historicalId = randomUUID();
  const otherVisitId = randomUUID();
  const oldCustomerId = randomUUID();
  await post('service-documents', { id: historicalId, document: {
    id: historicalId, documentType: 'invoice', stage: 'accepted', invoiceNumber: 'INV-HISTORICAL',
    customerName, customerId: oldCustomerId, vehicle: '2016 Ford', total: 100, paidAmount: 100
  } });
  await post('service-documents', { id: otherVisitId, document: {
    id: otherVisitId, documentType: 'invoice', stage: 'accepted', invoiceNumber: 'INV-OTHER-VISIT',
    customerName, customerId, total: 100, paidAmount: 100
  } });
  await post('invoice-response', {
    op: 'record-manual-payment', action: 'pay', invoiceId: otherVisitId, invoiceNumber: 'INV-OTHER-VISIT',
    customerId, customerName, paymentAmount: 100
  });
  const cards = await (await page.request.get('/api/workitems', { headers })).json();
  const oldJob = cards.find((card: { invoiceId?: string }) => card.invoiceId === otherVisitId);
  await post('settings', { key: 'schedule.settings', value: {
    openHour: 0, closeHour: 24, timeZone: 'America/Chicago', showWeekends: true
  } });
  await post('schedule', {
    start: new Date(Date.now() + 3600000).toISOString(), end: new Date(Date.now() + 7200000).toISOString(),
    resource: 'bay-1', customerId, workItemId: oldJob.id
  });
  const legacy = await post('workitems', { title: customerName, laneId: invoiceLaneId, customerId });

  await signInToDashboard(page, email, password);
  const add = page.getByRole('button', { name: 'Add to Invoices', exact: true });
  const invoices = page.locator('.lane').filter({ has: add });
  const unlinked = invoices.locator('.card').filter({ has: page.getByRole('button', { name: 'Create Invoice', exact: true }) });
  await expect(unlinked.getByRole('button', { name: /Invoice:/ })).toHaveCount(0);
  await expect(invoices.getByRole('button', { name: 'Invoice: INV-HISTORICAL' })).toBeVisible();
  const scheduled = page.locator('.lane').filter({ has: page.getByRole('button', { name: 'Add to Scheduled', exact: true }) });
  await expect(scheduled.getByText(customerName, { exact: true })).toBeVisible();
  await expect(invoices.getByRole('button', { name: 'Invoice: INV-OTHER-VISIT' })).toHaveCount(0);

  await add.click();
  await page.getByRole('textbox', { name: 'Search customers' }).fill(customerName);
  await page.getByRole('button', { name: `Create invoice for ${customerName}` }).click();
  await expect(page.getByRole('heading', { name: 'New Invoice Wizard' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Saved as draft', { exact: true })).toBeVisible();
  async function drafts() {
    const response = await page.request.get('/api/service-documents', { headers });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).items.map((item: { document: object }) => item.document)
      .filter((doc: { stage?: string }) => doc?.stage === 'draft') as Array<{ id: string; invoiceNumber: string; customerId: string }>;
  }
  await expect.poll(async () => (await drafts()).length).toBe(1);
  const [newDraft] = await drafts();
  expect(newDraft.customerId).toBe(customerId);
  await page.goto('/dashboard');
  await invoices.getByRole('button', { name: `Invoice: ${newDraft.invoiceNumber}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${newDraft.id}$`));
  await expect(page.getByRole('heading', { name: newDraft.invoiceNumber, exact: true })).toBeVisible();

  await page.goto('/dashboard');
  await unlinked.getByRole('button', { name: 'Create Invoice', exact: true }).click();
  expect(new URL(page.url()).searchParams.get('workItemId')).toBe(legacy.id);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(async () => {
    const cards = await (await page.request.get('/api/workitems', { headers })).json();
    return cards.find((card: { id: string }) => card.id === legacy.id)?.title;
  }).toMatch(/\[doc=inv-/);

  await page.goto('/dashboard');
  await add.click();
  await page.getByRole('button', { name: 'Add New Customer' }).click();
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ json: [] }));
  const customerForm = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Add Customer', exact: true }) });
  for (const [field, value] of Object.entries({
    'First Name *': 'First-time', 'Last Name *': 'Invoice Customer', 'Phone *': '5125550106',
    'Email *': 'first-invoice@example.test', 'Address *': '100 Example Street',
    'Make *': 'Jeep', 'Model *': 'Gladiator', 'Year *': '2024'
  })) {
    await customerForm.getByRole('textbox', { name: field, exact: true }).fill(value);
  }
  await customerForm.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Invoice Wizard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
});

test('the dashboard saves a phone lead with just a name and phone', async ({ page }) => {
  const email = `phone-lead-${randomUUID()}@example.test`;
  const password = randomUUID();
  const tenant = await staffWorkspace(page.request, email, password);
  const headers = { 'x-tenant-id': tenant };
  await signInToDashboard(page, email, password);
  await page.getByRole('button', { name: 'Add to Leads', exact: true }).click();
  await page.getByRole('button', { name: 'Add New Customer' }).click();
  await expect(page.getByRole('heading', { name: 'New Phone Lead' })).toBeVisible();
  const saveLead = page.getByRole('button', { name: 'Save Lead', exact: true });
  await page.getByRole('textbox', { name: 'First Name *', exact: true }).fill('First-time caller');
  await page.getByRole('textbox', { name: 'Phone *', exact: true }).fill('51255501');
  await expect(saveLead).toBeDisabled();
  await page.getByRole('textbox', { name: 'Phone *', exact: true }).fill('5125550143');
  await saveLead.click();
  await expect(page.getByRole('heading', { name: 'New Phone Lead' })).toBeHidden();
  await expect(page.locator('.card').getByText('First-time caller', { exact: true })).toBeVisible();

  const customers = async (): Promise<Array<{ id: string; name: string; phone: string; email: string }>> =>
    (await page.request.get('/api/customers', { headers })).json();
  const cards = async (): Promise<Array<{ customerId: string; leadSource: string; message: string }>> =>
    (await page.request.get('/api/workitems', { headers })).json();
  const customer = (await customers()).find(row => row.name === 'First-time caller');
  expect(customer).toMatchObject({ phone: '+15125550143', email: '' });
  expect((await cards()).find(row => row.customerId === customer!.id)).toMatchObject({ leadSource: 'phone', message: '' });

  await page.reload();
  await expect(page.locator('.card').getByText('First-time caller', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add to Leads', exact: true }).click();
  await page.getByRole('textbox', { name: 'Phone inquiry notes' }).fill('Called back about a lift');
  await page.getByRole('button', { name: 'Add New Customer' }).click();
  await page.getByRole('textbox', { name: 'Phone *', exact: true }).fill('5125550143');
  await page.getByRole('button', { name: 'Use existing customer First-time caller' }).click();
  await expect.poll(async () => (await cards()).find(row => row.message === 'Called back about a lift')).toMatchObject({
    customerId: customer!.id, leadSource: 'phone'
  });
  expect((await customers()).filter(row => row.phone === '+15125550143')).toHaveLength(1);
});

test('a generated widget accepts a callback from another origin', async ({ page, context, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pathflow.dev.auth.user', JSON.stringify({
      role: 'admin', email: 'widget-qa@example.test', displayName: 'Widget QA'
    }));
  });
  await page.goto('/admin-settings');
  await page.getByText('Web Widget', { exact: true }).first().click();
  const generated = await page.locator('ui-textarea.widget-code textarea').inputValue();
  expect(generated).toContain("const apiUrl = '/api/widget/lead'");
  const snippet = generated.replace("const apiUrl = '/api/widget/lead'", "const apiUrl = 'http://127.0.0.1:7071/api/widget/lead'");
  const site = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(snippet);
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  try {
    const address = site.address();
    if (!address || typeof address === 'string') throw new Error('The widget fixture has no HTTP port.');
    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`http://127.0.0.1:${address.port}/contact`);
    await phone.locator('[name=firstName]').fill('Callback');
    await phone.locator('[name=lastName]').fill('Fixture');
    await phone.locator('[name=phone]').fill('5125550102');
    await phone.locator('[name=message]').fill('Please call about a synthetic service request.');
    const [response] = await Promise.all([
      phone.waitForResponse('http://127.0.0.1:7071/api/widget/lead', { timeout: 8000 }),
      phone.getByRole('button', { name: 'Send Request' }).click()
    ]);
    const lead = await response.json();
    expect(lead.leadCreated).toBe(true);
    expect(lead.sms.confirmationAttempted).toBe(false);
    await expect(phone.getByRole('status')).toContainText('Your request was sent');
    const cards = await request.get('/api/workitems', { headers: {
      'x-tenant-id': lead.tenantId, 'x-dev-user-email': 'widget-qa@example.test', 'x-dev-user-roles': 'authenticated,admin'
    } });
    expect((await cards.json()).some((item: { id: string }) => item.id === lead.leadId)).toBe(true);
  } finally {
    site.close();
  }
});

test('external checkout stays pending in a non-default workspace', async ({ page, context, request }) => {
  const tenant = await staffWorkspace(request);
  const headers = { 'x-tenant-id': tenant };
  const invoiceId = randomUUID();
  const publicToken = randomUUID();
  const published = await request.post('/api/invoice-response', { headers, data: {
    op: 'publish-snapshot', invoiceId, publicToken, invoiceNumber: 'INV-QA',
    amount: '180.00', paymentProvider: 'stripe', paymentUrl: 'https://checkout.example.test/invoice',
    invoiceData: { total: 180, subtotal: 180, lineItems: [] }
  } });
  expect(published.ok()).toBeTruthy();
  await context.route('https://checkout.example.test/**', route => route.fulfill({ body: 'Isolated checkout fixture' }));
  const query = new URLSearchParams({ invoiceId, tenantId: tenant, publicToken, paid: '1' });
  await page.goto(`/invoice-payment?${query}`);
  await page.getByRole('button', { name: 'Checkout & Pay' }).click();
  await expect(page.getByText(/Payment is not yet confirmed here/)).toBeVisible();
  const pending = await request.get(`/api/invoice-response?invoiceId=${invoiceId}`, { headers });
  expect((await pending.json()).item.paidAmount).toBe(0);
});
test('one customer visit link follows the quote, invoice, appointment and pickup', async ({ page, browser }) => {
  const email = `portal-staff-${randomUUID()}@example.test`;
  const password = randomUUID();
  const tenant = await staffWorkspace(page.request, email, password);
  const headers = { 'x-tenant-id': tenant };
  async function post(path: string, data: object) {
    const response = await page.request.post(`/api/${path}`, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }
  const { id: customerId } = await post('customers', {
    name: 'Portal Test Customer', email: 'portal-customer@example.test', phone: '+15125550129',
    vehicleYear: '2024', vehicleMake: 'Jeep', vehicleModel: 'Wrangler'
  });
  await post('settings', {
    key: 'billing.paymentProviders', value: {
      defaultProvider: 'stripe', providers: [{ key: 'stripe', label: 'Stripe', connected: true, mode: 'test' }]
    }
  });
  await post('settings', { key: 'schedule.settings', value: {
    openHour: 0, closeHour: 24, timeZone: 'America/Chicago', showWeekends: true
  } });

  await signInToDashboard(page, email, password);
  await page.goto(`/invoices/new?type=quote&customerId=${customerId}`);
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  await next.click();
  await page.getByRole('button', { name: 'Add Labor Line' }).click();
  const fields = page.locator('.line-item-row .line-field');
  await fields.nth(0).fill('Wheel alignment');
  await fields.nth(1).fill('100');
  await next.click();
  await next.click();
  await page.locator('textarea.field-textarea').first().fill('INTERNAL SHOP NOTE');
  await next.click();
  const quoteSms = page.waitForResponse(response =>
    response.url().endsWith('/api/sms') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send Quote', exact: true }).click();
  const smsResponse = await quoteSms;
  expect(smsResponse.ok()).toBeTruthy();
  const message = smsResponse.request().postDataJSON().message as string;
  const link = new URL(message.slice(message.indexOf('http')));
  expect(link.pathname).toBe(`/visit/${tenant}`);
  expect(link.search).toBe('');
  expect(message.length).toBeLessThan(250);

  const portal = await browser.newContext({ baseURL: link.origin });
  const customer = await portal.newPage();
  try {
    await customer.goto(link.href);
    await expect(customer.getByText('Wheel alignment', { exact: false })).toBeVisible();
    await expect(customer.getByText('INTERNAL SHOP NOTE')).toHaveCount(0);
    await customer.getByRole('button', { name: 'Accept Quote', exact: true }).click();
    await expect(customer.getByText('Quote accepted.', { exact: true })).toBeVisible();
    await page.waitForURL(/\/quotes\/[^/]+$/);
    await page.reload();
    await page.getByRole('button', { name: 'Create Invoice', exact: true }).click();
    await page.waitForURL(/\/invoices\/[^/]+$/);
    const invoicePath = new URL(page.url()).pathname;
    const invoiceId = decodeURIComponent(invoicePath.split('/').at(-1)!);
    await page.getByRole('button', { name: 'Send Invoice', exact: true }).click();
    const invoiceSms = page.waitForResponse(response =>
      response.url().endsWith('/api/sms') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send Now', exact: true }).click();
    const invoiceSmsResponse = await invoiceSms;
    expect(invoiceSmsResponse.ok()).toBeTruthy();
    expect(invoiceSmsResponse.request().postDataJSON().message).toContain(link.href);

    const token = link.hash.slice(1);
    await customer.getByRole('button', { name: 'Refresh', exact: true }).click();
    await customer.getByRole('link', { name: 'Pay Invoice', exact: true }).click();
    await expect(customer.getByRole('link', { name: 'Back to your visit' })).toBeVisible();
    await expect(customer.getByRole('button', { name: 'Checkout & Pay' })).toBeVisible();
    await customer.getByRole('link', { name: 'Back to your visit' }).click();
    await expect(customer).toHaveURL(link.href);

    const { invoice } = await (await customer.request.get('/api/customer-portal', {
      headers: { ...headers, 'x-visit-token': token }
    })).json();
    expect(invoice.id).toBe(invoiceId);
    const unrelated = randomUUID();
    await post('service-documents', { id: unrelated, document: {
      id: unrelated, documentType: 'invoice', stage: 'sent', customerId,
      customerName: 'Portal Test Customer', invoiceNumber: 'INV-UNRELATED'
    } });
    await post('invoice-response', {
      op: 'publish-snapshot', invoiceId: unrelated, invoiceNumber: 'INV-UNRELATED',
      publicToken: randomUUID(), amount: '100.00', invoiceData: { total: 100 }, paymentProvider: 'stripe'
    });
    const otherInvoice = await customer.request.get('/api/invoice-response', {
      headers, params: { invoiceId: unrelated, publicToken: token }
    });
    expect(otherInvoice.status()).toBe(404);
    const otherTenant = await customer.request.get('/api/customer-portal', {
      headers: { 'x-tenant-id': 'unrelated-workspace', 'x-visit-token': token }
    });
    expect(otherTenant.status()).toBe(404);

    await post('invoice-response', {
      op: 'record-manual-payment', action: 'pay', invoiceId, invoiceNumber: invoice.number,
      customerId, customerName: 'Portal Test Customer', paymentAmount: 100
    });
    const cards = await (await page.request.get('/api/workitems', { headers })).json();
    const job = cards.find((item: { invoiceId?: string }) => item.invoiceId === invoiceId);
    expect(job).toBeTruthy();
    await post('schedule', {
      start: new Date(Date.now() + 3600000).toISOString(), end: new Date(Date.now() + 7200000).toISOString(),
      resource: 'bay-1', customerId, workItemId: job.id
    });
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Send scheduled info', exact: true }).click();
    const appointmentDelivery = page.waitForResponse(response =>
      response.url().endsWith('/api/email') && response.request().method() === 'POST');
    const appointmentDialog = page.getByRole('dialog', { name: 'Send Scheduled Info' });
    await appointmentDialog.getByRole('button', { name: 'Send Info', exact: true }).click();
    const appointmentResponse = await appointmentDelivery;
    expect(appointmentResponse.ok()).toBeTruthy();
    expect(appointmentResponse.request().postDataJSON().message).toContain(link.href);
    await expect(appointmentDialog).toBeHidden();
    await customer.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(customer.getByRole('heading', { name: 'Appointment', exact: true })).toBeVisible();
    await expect(customer.getByRole('heading', { name: 'Payment history', exact: true })).toBeVisible();
    const receipt = customer.waitForEvent('download');
    await customer.getByRole('button', { name: 'Download receipt' }).click();
    expect((await receipt).suggestedFilename()).toMatch(/^receipt-/);
    await post('workitems', { id: job.id, checkedInAt: new Date().toISOString(), workClockAction: 'check-in' });
    await post('workitems', { id: job.id, workClockAction: 'start' });
    await customer.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(customer.getByText('In the shop', { exact: true })).toBeVisible();
    await post('workitems', { id: job.id, completedAt: new Date().toISOString() });
    await customer.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(customer.getByText('Ready for pickup', { exact: true })).toBeVisible();
    await post('workitems', { id: job.id, markPickedUp: true });
    await customer.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(customer.getByText('Picked up', { exact: true })).toBeVisible();
    await expect(customer.getByText('Paperwork is available through', { exact: false })).toBeVisible();
    await expect(customer.getByRole('link', { name: 'Pay Invoice', exact: true })).toHaveCount(0);
    await page.goto(invoicePath);
    await page.getByRole('button', { name: 'Customer Portal', exact: true }).click();
    const access = page.getByRole('dialog', { name: 'Customer Portal' });
    await expect(access.getByRole('textbox', { name: 'Visit link' })).toHaveValue(link.href);
    await access.getByRole('button', { name: 'Revoke link' }).click();
    await expect(access.getByText('Link revoked.', { exact: true })).toBeVisible();
    await customer.reload();
    await expect(customer.getByRole('alert')).toContainText('unavailable');
    await access.getByRole('button', { name: 'Create new link' }).click();
    await expect(access.getByText('New link created.', { exact: true })).toBeVisible();
    const replacement = await access.getByRole('textbox', { name: 'Visit link' }).inputValue();
    expect(replacement).not.toBe(link.href);
    await customer.goto(replacement);
    await expect(customer.getByText('Paperwork is available through', { exact: false })).toBeVisible();
  } finally {
    await portal.close();
  }
});
