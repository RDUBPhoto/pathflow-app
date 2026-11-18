import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'shop-workflow.spec.ts',
  timeout: 45000,
  workers: 1,
  reporter: [['list']],
  outputDir: process.env.PATHFLOW_SHOP_TEST_OUTPUT,
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});
