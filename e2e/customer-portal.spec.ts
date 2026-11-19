import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('portal timeline supports mobile, themes, keyboard use and downloadable multipage paperwork', async ({ page }, testInfo) => {
  const payment = { kind: 'Payment', amount: 75, date: '2026-11-19T15:00:00Z', reference: 'deposit-reference' };
  const lines = Array.from({ length: 85 }, (_, index) => ({
    description: `Item ${index + 1}: suspension inspection and installation for the customer vehicle, including hardware checks and adjustments.`,
    quantity: 1, total: 100, subtotal: 100, unitPrice: 100
  }));
  const timeline = [
    ['quote', 'Quote & approval', 'file-text'], ['invoice', 'Invoice', 'receipt'], ['payment', 'Payment', 'credit-card'],
    ['schedule', 'Scheduled', 'calendar'], ['work', 'In the shop', 'tools'], ['ready', 'Ready for pickup', 'circle-check'], ['pickup', 'Picked up', 'flag']
  ].map(([id, label, icon], index) => ({
    id, label, icon, state: index < 4 ? 'complete' : index === 4 ? 'current' : 'upcoming',
    at: index <= 4 ? '2026-11-19T15:00:00Z' : '', description: 'Your visit details and customer paperwork are available here.',
    events: id === 'payment' ? [{ at: payment.date, label: 'Payment', paymentIndex: 0, stepId: 'payment' }] : []
  }));
  const visit = {
    businessName: 'Portal Test Shop', customerName: 'José Customer', vehicle: '2024 Jeep Wrangler', progress: 'In the shop',
    status: 'active', expiresAt: '', activity: [], timeline, appointment: null,
    quote: { id: 'quote-preview', number: 'QTE-PREVIEW', stage: 'accepted', total: 8500, subtotal: 8500, tax: 0,
      lines, canRespond: false, note: 'Please bring your keys.' },
    invoice: { id: 'invoice-preview', number: 'INV-PREVIEW', total: 8500, subtotal: 8500, tax: 0,
      balance: 8425, dueDate: '2026-11-21', lines, canPay: false }, payments: [payment]
  };
  await page.route('**/api/customer-portal', route => route.fulfill({ json: visit }));
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/visit/preview#vp_fixture');
      await page.evaluate(theme => {
        localStorage.setItem('pathflow.ui.theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-bs-theme', theme);
        document.documentElement.style.colorScheme = theme;
      }, theme);
      const timeline = page.getByRole('region', { name: 'Visit timeline', exact: true });
      await expect(timeline.locator('[aria-current="step"]')).toContainText('In the shop');
      const quoteStep = timeline.getByRole('button', { name: /^Quote & approval / });
      if (await quoteStep.getAttribute('aria-expanded') === 'true') await quoteStep.click();
      await quoteStep.focus();
      await page.keyboard.press('Enter');
      await expect(quoteStep).toHaveAttribute('aria-expanded', 'true');
      await expect(timeline.getByRole('button', { name: 'Download quote', exact: true })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await timeline.screenshot({ path: testInfo.outputPath(`timeline-${theme}-${width}.png`) });
    }
  }
  const panel = page.getByRole('region', { name: 'Visit timeline', exact: true });
  for (const [step, button, filename] of [
    ['Quote & approval', 'Download quote', 'quote-QTE-PREVIEW.pdf'],
    ['Invoice', 'Download invoice', 'invoice-INV-PREVIEW.pdf'],
    ['Payment', 'Receipt · $75.00', 'receipt-INV-PREVIEW-1.pdf']
  ]) {
    const trigger = panel.getByRole('button', { name: new RegExp('^' + step.replace('&', '\\&') + ' ') });
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: button, exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(filename);
    expect(await file.failure()).toBeNull();
    await file.saveAs(testInfo.outputPath(filename));
    const bytes = await readFile((await file.path())!);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
    if (!filename.startsWith('receipt-')) expect((bytes.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBeGreaterThan(1);
  }
});
