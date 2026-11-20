import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { expectCloseAlignment } from './close-alignment';

const output = path.join(process.cwd(), 'dist/web/browser');
const index = readFileSync(path.join(output, 'index.html'), 'utf8');
const main = index.match(/src="(main-[^"]+\.js)"/)![1];
const styles = index.match(/href="(styles-[^"]+\.css)"/)![1];
const routeChunk = (selector: string) => readdirSync(output).find(file =>
  /^chunk-.*\.js$/.test(file) && ['`', '"'].some(quote => readFileSync(path.join(output, file), 'utf8')
    .includes('selectors:[[' + quote + selector + quote + ']]')))!;

async function countDocuments(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('test.documents',
    String(Number(sessionStorage.getItem('test.documents') || 0) + 1)));
}

async function documents(page: Page) {
  return page.evaluate(() => Number(sessionStorage.getItem('test.documents')));
}

async function open(page: Page, url: string) {
  await page.goto(url).catch(error => {
    if (!/ERR_ABORTED|interrupted by another navigation/.test(error.message)) throw error;
  });
}

async function failAsset(page: Page, file: string, persistent = false) {
  let failures = 0;
  await page.route('**/' + file, route => {
    if (!persistent && failures) return route.continue();
    failures++;
    return route.fulfill({ status: 404, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: 'Missing previous release asset' });
  });
  return () => failures;
}

async function account(page: Page, request: APIRequestContext) {
  const email = 'idle-' + randomUUID() + '@example.test';
  const password = randomUUID();
  const signup = await request.post('/api/access', {
    data: { op: 'password-signup', email, password, displayName: 'Idle QA', phone: '5125550100' }
  });
  expect(signup.ok()).toBeTruthy();
  expect((await request.post('/api/access', { data: { op: 'bootstrap', locations: ['Idle QA Shop'] } })).ok()).toBeTruthy();
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { email, password };
}

test('idle logout with an open overlay reaches a usable login and signs back in without another reload', async ({ page, request }) => {
  await countDocuments(page);
  await page.clock.install();
  const user = await account(page, request);
  const previousSession = (await page.context().cookies()).find(cookie => cookie.name === 'pf_session')!.value;
  const before = await documents(page);
  await page.getByRole('textbox', { name: 'Global search', exact: true }).fill('idle test');
  await expect(page.getByRole('textbox', { name: 'Search the workspace', exact: true })).toBeVisible();
  await expectCloseAlignment(page.getByRole('button',{name:'Close search',exact:true}));
  await page.clock.fastForward(31 * 60 * 1000);
  await expect(page).toHaveURL(/\/login\?reason=idle$/);
  await expect(page.getByRole('status').filter({ hasText: '30 minutes of inactivity' })).toBeVisible();
  expect(await documents(page)).toBe(before + 1);
  await page.evaluate(() => sessionStorage.setItem('pathflow.auth.idle.rehydrate.pending', '1'));
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.locator('#login-password')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('textbox', { name: 'Global search', exact: true })).toBeEditable();
  expect(await documents(page)).toBe(before + 1);
  expect((await page.context().cookies()).find(cookie => cookie.name === 'pf_session')!.value).not.toBe(previousSession);
});

test('a missing lazy login chunk recovers to the requested login instead of freezing the homepage', async ({ page }) => {
  await countDocuments(page);
  await page.goto('/?reason=idle');
  const failures = await failAsset(page, routeChunk('app-login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeEditable();
  expect(failures()).toBe(1);
  expect(await documents(page)).toBe(2);
  await expect(page.locator('#pathflow-asset-recovery')).toHaveCount(0);
});

test('missing workspace chunks offer an explicit reload rather than automatically replacing staff work', async ({ page, request }) => {
  await countDocuments(page);
  await account(page, request);
  const before = await documents(page);
  await failAsset(page, routeChunk('app-inventory'));
  await page.getByRole('link', { name: 'Parts Catalog', exact: true }).click();
  const notice = page.locator('#pathflow-asset-recovery');
  await expect(notice).toContainText('Save any changes first');
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(await documents(page)).toBe(before);
  await notice.getByRole('link', { name: 'Reload page', exact: true }).click();
  await expect(page).toHaveURL(/\/inventory$/);
  await expect(page.getByRole('heading', { name: 'Parts Catalog', exact: true })).toBeVisible();
  expect(await documents(page)).toBe(before + 1);
});

for (const file of [main, styles]) {
  test(`a missing startup ${file.endsWith('.css') ? 'stylesheet' : 'main bundle'} recovers before login is used`, async ({ page }) => {
    await countDocuments(page);
    const failures = await failAsset(page, file);
    await open(page, '/login?redirect=%2Fcustomers');
    await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeEditable();
    await expect.poll(() => documents(page)).toBe(2);
    expect(failures()).toBe(1);
    expect(new URL(page.url()).searchParams.get('redirect')).toBe('/customers');
    expect(new URL(page.url()).searchParams.has('__pathflow_reload')).toBe(false);
    await expect(page.locator('#pathflow-asset-recovery')).toHaveCount(0);
  });
}

test('a persistent missing bundle reloads only once and offers a usable manual retry', async ({ page }) => {
  await countDocuments(page);
  const failures = await failAsset(page, main, true);
  await open(page, '/login');
  const notice = page.locator('#pathflow-asset-recovery');
  await expect(notice).toBeVisible();
  expect(failures()).toBe(2);
  expect(await documents(page)).toBe(2);
  await page.waitForTimeout(500);
  expect(await documents(page)).toBe(2);
  await page.unroute('**/' + main);
  await notice.getByRole('link', { name: 'Reload page', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeEditable();
  expect(await documents(page)).toBe(3);
});

test('unavailable recovery storage shows a retry without an automatic reload loop', async ({ page }) => {
  await countDocuments(page);
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'pathflow.assets.recovery.v2') throw new DOMException('Storage blocked', 'SecurityError');
      return set.call(this, key, value);
    };
  });
  await failAsset(page, main, true);
  await open(page, '/login');
  const notice = page.locator('#pathflow-asset-recovery');
  await expect(notice).toBeVisible();
  expect(await documents(page)).toBe(1);
  await page.unroute('**/' + main);
  await notice.getByRole('link', { name: 'Reload page', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeEditable();
});

test('unrelated extension message errors do not trigger asset recovery', async ({ page }) => {
  await countDocuments(page);
  await page.goto('/login');
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeEditable();
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', {
    message: 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'
  })));
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.locator('#login-password')).toHaveAttribute('type', 'text');
  expect(await documents(page)).toBe(1);
  await expect(page.locator('#pathflow-asset-recovery')).toHaveCount(0);
});
