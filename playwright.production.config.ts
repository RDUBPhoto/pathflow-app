import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['production-auth.spec.ts', 'customer-portal.spec.ts'],
  timeout: 45000,
  workers: 1,
  reporter: [['list']],
  outputDir: process.env.PATHFLOW_PRODUCTION_TEST_OUTPUT,
  use: {
    baseURL: 'https://localhost:14443',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});
