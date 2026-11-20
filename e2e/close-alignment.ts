import { expect, type Locator } from '@playwright/test';

export async function expectCloseAlignment(button: Locator) {
  await expect(button).toBeVisible();
  await expect.poll(async () => button.evaluate(element => {
    const header = element.closest('.modal-header, .ui-toolbar, .notifications-header, .modal-head, .vendor-modal-head, .feedback-head, .quick-setup-head, .global-search-header') || element.parentElement;
    if (!header) throw new Error('Missing close-button header');
    const rect = element.getBoundingClientRect(), parent = header.getBoundingClientRect();
    const style = getComputedStyle(element), parentStyle = getComputedStyle(header);
    // Standard headers should align with their balanced content padding. Using
    // the start padding catches a hidden end gutter reserved for absolute icons.
    const end = parent.right - (style.position === 'absolute' ? parseFloat(style.right) || 0
      : parseFloat(header.classList.contains('modal-header') ? parentStyle.paddingLeft : parentStyle.paddingRight) || 0)
      - (parseFloat(parentStyle.borderRightWidth) || 0);
    const contentTop = parent.top + (parseFloat(parentStyle.paddingTop) || 0) + (parseFloat(parentStyle.borderTopWidth) || 0);
    const contentBottom = parent.bottom - (parseFloat(parentStyle.paddingBottom) || 0) - (parseFloat(parentStyle.borderBottomWidth) || 0);
    const verticalError = style.position !== 'absolute' && parentStyle.alignItems === 'center'
      ? Math.abs(rect.top + rect.height / 2 - (contentTop + contentBottom) / 2) : 0;
    return Math.max(Math.abs(end - rect.right), verticalError);
  })).toBeLessThan(2);
  const geometry = await button.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, viewport: innerWidth };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(24);
  expect(geometry.height).toBeGreaterThanOrEqual(24);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
}
