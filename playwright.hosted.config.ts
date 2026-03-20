import { defineConfig } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://wonderful-glacier-0f45f5110.6.azurestaticapps.net';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['hosted-smoke.spec.ts'],
  timeout: 60_000,
  expect: {
    timeout: 15_000
  },
  fullyParallel: false,
  retries: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-hosted' }],
    ['junit', { outputFile: 'test-results/playwright/hosted-junit.xml' }]
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
});
