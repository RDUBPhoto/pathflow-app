# Web

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 19.2.1.

## Node.js version

Local API development uses Azure Functions and requires Node 18.

```bash
nvm use
```

If Node 18 is not installed yet:

```bash
nvm install 18
nvm use 18
```

## Development server

To start a local development server, run:

```bash
npm start
```

This starts Angular + Azure Functions + Azurite together. Once running, open `http://localhost:4200/`.

## API URL Safety (Local vs Production)

Local:
1. Use `npm start` (`scripts/dev-local.mjs`).
2. Frontend calls `/api/*` via `proxy.conf.local.json` to `http://localhost:7071`.

Production:
1. Do not use localhost URLs in app settings.
2. Set `APP_BASE_URL` (or `PUBLIC_APP_BASE_URL`) to your public site origin, for example `https://yourdomain.com`.

`/api/access` now rejects localhost origins when running in production, so invite/verification/password-reset links cannot be generated with localhost.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

For CI-style unit tests with coverage:

```bash
npm run test:unit:ci
```

## Running end-to-end tests

For Playwright E2E smoke flows:

```bash
npm run test:e2e
```

Hosted smoke checks (runs against deployed URL, no local server):

```bash
PLAYWRIGHT_BASE_URL=https://www.pathflow-app.com npm run test:e2e:hosted
```

## Daily QA report

To run the full QA suite (unit + E2E) and generate a report:

```bash
npm run test:qa
```

Artifacts:
1. QA markdown report: `qa-reports/<timestamp>-report.md`
2. Unit test coverage: `coverage/web/index.html`
3. Playwright HTML report: `playwright-report/index.html`
4. Playwright JUnit XML: `test-results/playwright/junit.xml`

Optional nightly email summary:
1. Set `QA_REPORT_EMAIL_TO` to one or more recipient emails (comma-separated).
2. Ensure `SENDGRID_API_KEY` and `EMAIL_FROM` are set (env vars or `api/local.settings.json`).
3. `npm run test:qa` will send a PASS/FAIL summary email after writing the report.

## Scheduled hosted QA

GitHub Actions workflow `.github/workflows/hosted-qa-smoke.yml` runs hosted smoke tests three times per week (Mon/Wed/Fri, 07:00 UTC).

Required GitHub secret:
1. `PLAYWRIGHT_BASE_URL` set to your hosted app origin (for example `https://www.pathflow-app.com`).

Optional hosted QA summary email (sent every scheduled/manual run):
1. `QA_REPORT_EMAIL_TO` recipient email(s), comma-separated (for example `robert@pathflow-app.com`).
2. `SENDGRID_API_KEY` valid SendGrid API key.
3. `EMAIL_FROM` verified sender email.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
