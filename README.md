# Web

The application uses Angular 22.2 with the Angular application build package.

## Node.js version

Local development, release tests, and the hosted API use Node 22.

```bash
nvm use
```

If Node 22 is not installed yet:

```bash
nvm install 22
nvm use 22
```

## Development server

Install the local Functions host and the storage emulator used by release tests. Azurite 3.38 supports the storage API version used by the current Azure SDK.

```bash
npm install --global azure-functions-core-tools@4 azurite@3.38.0
```

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

## Data Storage Backend (Table vs SQL)

The API now supports two storage backends for entity data:

1. `table` (Azure Table Storage, legacy/default)
2. `sql` (Azure SQL, recommended for production hardening)

Backend selection:

1. Set `DATA_BACKEND=sql` to force Azure SQL.
2. Set `DATA_BACKEND=table` to force Azure Table Storage.
3. If unset, API uses `sql` when SQL env vars exist, otherwise falls back to `table`.

Required SQL env vars (either form):

1. `SQL_CONNECTION_STRING`
2. or `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, `SQL_PASSWORD`

Migration helper:

```bash
cd api
npm run migrate:table-to-sql
```

This copies existing data from Azure Table Storage (`STORAGE_CONNECTION_STRING`) into SQL entity storage table `dbo.PathflowEntities`.

## Auth Provider Runtime Config (Prod-friendly)

`/api/access?op=auth-config` now exposes safe auth provider flags so login/signup can be controlled by Azure App Settings (without rebuilding frontend).

Optional app settings:

1. `AUTH_PRIMARY_PROVIDER` (default `local` for the server-verified email/password flow)
2. `AUTH_PROVIDERS` (comma-separated, for example `aad,google`)
3. `AUTH_GOOGLE_ENABLED` (`true|false`, convenience flag)
4. `AUTH_HOSTED_EMAIL_ENABLED` (`true|false`)
5. `AUTH_HOSTED_EMAIL_PROVIDER` (custom SWA provider id for email/password identity flow)
6. `AUTH_LOCAL_PASSWORD_ENABLED` (`true|false`, enables server-verified email/password and passkeys in production)

Notes:

1. Local dev quick-login still follows `environment.development.ts` and localhost behavior.
2. Hosted email/password uses the API’s secure HttpOnly session cookie. Microsoft and Google use the configured SWA provider and exchange the verified profile for an app session. Development identities are accepted only by an explicitly isolated development runtime.

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

## Shop release checks

Run `npm run test:api`, `npm run test:unit:ci`, `npm run test:e2e:regression`, and `npm run test:shop:isolated` before publishing. The shop suite needs Azure Functions Core Tools 4, Azurite 3, and the Playwright Chromium browser. It starts its own disposable storage and Functions runtime, uses synthetic customers with mock email and SMS, and refuses to run against a running local service. The Azure Static Web Apps workflow requires the regression gate before deploying.

On staging, verify the shop's app-session login, SQL readiness, a processor sandbox payment, and email and SMS delivery using test recipients. Send a new invoice link when the older link lacks a public token. External payment links stay pending until a verified settlement integration is in place or staff record a confirmed offline payment. A direct card attempt with an unknown result remains pending so retrying cannot initiate another charge against the same balance.

For the website widget, configure `WIDGET_ALLOWED_ORIGINS` with the actual published Squarespace origin and any explicitly approved test origin. Copy a fresh embed from Admin after release. Check form submission and lead arrival from a private Squarespace page before updating the public site.

### PayLynx checkout

Configure `PAYLYNX_ACCOUNTS_JSON` in the server environment with credentials for each location and mode. For example, the value can have this structure, with actual keys supplied securely in the environment.

```json
{
  "primary-location": {
    "test": { "sourceKey": "PRIVATE_SANDBOX_KEY", "tokenizationKey": "pk_PUBLIC_SANDBOX_KEY", "pin": "" },
    "live": { "sourceKey": "PRIVATE_LIVE_KEY", "tokenizationKey": "pk_PUBLIC_LIVE_KEY", "pin": "" }
  }
}
```

The first deployment uses the `test` account. Select test mode in Admin Settings → Payment Gateways, connect PayLynx, and make it the default. The connection verifies gateway access and card fees. Use a source key with Charge, View Transactions, Void and Refund permissions, and a public Hosted Tokenization key. Configure the gateway with card surcharges disabled. Each reversal uses the mode recorded on the original payment. Keep previous mode credentials available for outstanding payments and returns.

Local development also accepts the existing `PAYLYNX_SANDBOX_TENANT_ID`, `PAYLYNX_SANDBOX_SOURCE_KEY`, `PAYLYNX_SANDBOX_TOKENIZATION_KEY` and optional `PAYLYNX_SANDBOX_PIN` settings in isolated mock-outbound development. Hosted requests use the explicit location credentials in `PAYLYNX_ACCOUNTS_JSON`. The public API returns only the tokenization key and mode.

Workspace access is complimentary while `SUBSCRIPTION_BILLING_ENABLED` is absent or false. Pathflow subscription charging is deferred. Keep this flag disabled for the current release. Customer invoice payments continue through the shop's PayLynx account.

Use the processor's test card details for sandbox checkout. The local test flow uses mock email and SMS. See the [PayLynx API spec](https://docs.paylynxgateway.com/api/v2/spec) and [Hosted Tokenization guide](https://docs.paylynxgateway.com/tokenization/v0.3).

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

For local Playwright flows against your local dev stack:

```bash
npm run test:e2e
```

Hosted smoke checks (runs against deployed URL, no local server):

```bash
PLAYWRIGHT_BASE_URL=https://www.pathflow-app.com npm run test:e2e:hosted
```

## Deployment regression gate

Before deploying, run the same checks used by `.github/workflows/regression.yml`:

```bash
npm run test:api
npm run test:unit:ci
npm run build
npm run verify:deploy-output
npm run test:e2e:regression
```

The deploy-output check verifies that the production bundle and required API functions are present and that no local Functions URL leaked into the browser bundle.

## Authentication startup telemetry

The client records privacy-safe timings for auth bootstrap, auth configuration, current-session lookup, and the remembered biometric prompt. Production timings are accepted by `POST /api/telemetry` and written to structured Function logs.

To also export those events to Application Insights, configure the existing Function environment with `APPLICATIONINSIGHTS_CONNECTION_STRING`. The payload allowlist excludes credentials, email addresses, biometric data, passkey identifiers, and arbitrary client properties.

## Daily QA report

To run the full QA suite and generate a report:

- Unit tests run locally.
- Browser smoke tests run against the hosted deployment, not `localhost`.

```bash
npm run test:qa
```

Artifacts:
1. QA markdown report: `qa-reports/<timestamp>-report.md`
2. Unit test coverage: `coverage/web/index.html`
3. Hosted Playwright HTML report: `playwright-report-hosted/index.html`
4. Hosted Playwright JUnit XML: `test-results/playwright/hosted-junit.xml`

Optional:
1. Set `PLAYWRIGHT_BASE_URL` if production is not `https://www.pathflow-app.com`.

Optional nightly email summary:
1. Set `QA_REPORT_EMAIL_TO` to one or more recipient emails (comma-separated).
2. Ensure `SENDGRID_API_KEY` and `EMAIL_FROM` are set (env vars or `api/local.settings.json`).
3. `npm run test:qa` will send a PASS/FAIL summary email after writing the report.

## Local package tracking

Purchase order package tracking can refresh status and ETA through EasyPost.

Local setup:

```json
{
  "Values": {
    "EASYPOST_API_KEY": "your_easypost_test_or_production_key"
  }
}
```

Add the value to `api/local.settings.json` for local development. If the key is missing, purchase orders still save manual PO/tracking/ETA fields, but carrier status refresh stays disabled.

Release TODO:

- EasyPost is currently wired and verified with a test API key. Before releasing package auto-tracking to production, replace `EASYPOST_API_KEY` with the EasyPost production API key, confirm tracking billing is enabled, and run one live PO tracking refresh.

## Local parts email intake testing

The local-only `POST /api/parts-email-intake` endpoint lets QA paste a fake vendor confirmation/shipping email and update an existing purchase order line. It is intentionally blocked for non-local hosts unless `PARTS_EMAIL_INTAKE_HTTP_ENABLED=true` is set for a controlled test environment.

Example payload:

```json
{
  "purchaseOrderId": "existing-po-id",
  "lineId": "existing-line-id",
  "from": "orders@vendor.example",
  "to": "parts@shop.example",
  "subject": "Vendor order ORD-123 has shipped",
  "message": "Purchase Order: ORD-123\nSKU: SDHQ-RAPTOR-CV-C\nTracking #: EZ1000000001\nCarrier: USPS\nETA: 2026-07-12\nVendor Invoice #: INV-9001"
}
```

The parser extracts PO/order number, tracking number, carrier, ETA, vendor invoice number, SKU, and part name hints, then matches to an existing purchase order line. If it cannot match confidently, it returns `reviewRequired: true` and does not update a PO.

## Parts email webhook

Provider-neutral inbound email should post to `POST /api/parts-email-webhook/{tenantId?}`. The endpoint normalizes common inbound payload shapes such as SendGrid Inbound Parse, Mailgun routes, Postmark inbound, or a generic JSON body, then uses the same vendor-email parser and PO matcher as the local test endpoint.

Production setup:

```json
{
  "Values": {
    "PARTS_EMAIL_WEBHOOK_SECRET": "long-random-secret"
  }
}
```

Providers must include the shared secret in `x-pathflow-email-token`, `?token=`, or body `token`. Localhost requests can run without the secret for development.

Example generic webhook payload:

```json
{
  "provider": "generic",
  "to": "orders+shop@example.pathflow-app.com",
  "from": "orders@vendor.example",
  "subject": "Vendor order ORD-123 shipped",
  "message": "PO: ORD-123\nSKU: SDHQ-RAPTOR-CV-C\nTracking #: 1Z999AA10123456784\nCarrier: UPS\nETA: 2026-07-12"
}
```

Tenant matching uses the recipient email against `parts.company.email` and `orders.inbox.email`. If the tenant or PO line cannot be matched confidently, the endpoint returns `reviewRequired: true` and does not update the PO.

Release TODO:

- Connect production inbound mail routing to `parts-email-webhook`. Gmail and Microsoft can use OAuth/API connectors. GoDaddy and other mailbox hosts should use the shop's existing parts email plus PathFlow-managed forwarding/inbound routing when available, or provider-level routing handled by operations.
- EasyPost package tracking is currently verified with a test API key; switch to the production EasyPost API key before release.

## Scheduled hosted QA

GitHub Actions workflow `.github/workflows/hosted-qa-smoke.yml` runs hosted smoke tests three times per week (Mon/Wed/Fri, 07:00 UTC).

Required GitHub secret:
1. `PLAYWRIGHT_BASE_URL` set to your hosted app origin (for example `https://www.pathflow-app.com`).

Optional hosted QA summary email (sent every scheduled/manual run):
1. `QA_REPORT_EMAIL_TO` recipient email(s), comma-separated (for example `robert@pathflow-app.com`).
2. `SENDGRID_API_KEY` valid SendGrid API key.
3. `EMAIL_FROM` verified sender email.

Set `QA_REPORT_EMAIL_FROM` to use a dedicated verified sender for hosted QA;
otherwise the report uses `EMAIL_FROM`. The sender identity must be verified in
the SendGrid account that owns `SENDGRID_API_KEY`. A 403 saying the from address
does not match a verified Sender Identity requires correcting that sender
configuration; rerunning the workflow will not repair it.

Hosted smoke tests require missing quote IDs to show `Response not confirmed`
and the missing-ID error, with no acceptance or decline confirmation. This
protects against claiming a customer response was saved without a quote ID.
Smoke failures fail the test step directly. Report-delivery failures fail the
email step separately, while report artifacts are still uploaded. Run
`npm run test:hosted:email` to check report error handling without sending email.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.

## Tabler UI

Angular bundles the precompiled stylesheet from `@tabler/core` and the selected
outline SVGs from `@tabler/icons`. Angular manages the interactions, including
dialogs, dropdowns, and forms. The Squarespace widget carries its own styles so
it can run on a separate site.

Use `npm ci` for repeatable builds. To update Tabler, install explicit versions
of both packages and commit `package.json` with `package-lock.json`. Run
`npm run build`, `npm run test:unit:ci`, and `npm run test:shop:isolated` before
merging. Add any new outline icon by name in `src/app/ui/_icons.scss`.
