# Azure Deployment Plan

> **Status:** Validated — application-only sandbox release to the existing Pathflow Static Web App.

## Current rollout scope

### Authorized hosted deployment on 2026-11-18

The user authorized deploying Pathflow and verifying hosted login, a $1.00 sandbox invoice payment
and its void. The delivery recipe is the existing GitHub Actions CI/CD workflow targeting
`pathflow-app` in `rg-pathflow-dev-us`, Pathflow subscription
`6c08277d-9b3c-40c6-923b-1c01ca2610a7`. The existing Standard Static Web App uses its managed API.
The previously confirmed Pathflow subscription and resource group are the rollout target.

Azure validation skill completed the application release checks. Production output verification,
clean API packaging and source comparison, workflow YAML validation, source credential-pattern scan
and full web/API dependency audits passed on 2026-11-18. Both audits report zero vulnerabilities.
The preceding complete regression proof remains current for this source. Git fetch confirmed the
release starts from the current main commit `550824c`. The existing deployment token is configured.
Static role verification covers zero new role assignments. This application deployment provisions
zero resources and keeps the existing resource topology and approved budget scope.

The deployment workflow will rebuild and rerun the regression gate on Linux, retain the tested
frontend/API artifacts, and upload them to the existing Static Web App. Hosted verification will
exercise a temporary staff account, a clearly identified sandbox invoice, card tokenization,
payment confirmation, void and the restored invoice balance. Test-created records will be cleaned
using their exact identifiers. The previous main commit remains available as the rollback source.

### Approved release follow-up completed on 2026-11-18

This section supersedes the remaining application release work in the initial audit below.
The user selected PayLynx sandbox for the first deployment and deferred Pathflow subscription charges.
Workspace access is complimentary with `SUBSCRIPTION_BILLING_ENABLED=false`. An expired historical
trial cannot lock a complimentary workspace. Revoked staff access remains enforced.

#### Framework, runtime and dependency updates

- Applied Angular migrations sequentially through 20, 21 and 22. Current framework is 22.2.6,
  CLI and application build package are 22.2.7, CDK is 22.3.0 and TypeScript is 6.0.3.
  Coupled Angular dependencies use exact versions to avoid mixed compiler/framework patches.
- Standardized Node 22.23.5 through `.nvmrc` and the development runner. Removed the npm-distributed
  Node binary dependency so package installation cannot remove the runtime used by the project.
- Updated API Azure Identity and Blob Storage SDKs. Updated local and CI Azurite to 3.38.0 for
  the current storage API version. Repaired the API test command to discover all test files in CI.
- The SMS SDK uses a scoped UUID 11.1.1 override. A transport regression exercises its actual
  request serialization and v4 repeatability identifier generation with the patched dependency.
- Full web and API dependency audits report zero vulnerabilities. The CI security gate checks
  the complete web dependency tree and production API dependencies before publishing artifacts.

#### Payment and access configuration

- Added hosted PayLynx test/live configuration scoped to each shop location. Server credentials
  select the correct API and public card-field script. Private source keys stay in server settings.
  Gateway connection requires current Admin access and verifies account access and card fees.
- Checkout, manual charging, voids and refunds share this configuration. Recorded payment mode
  selects reversal credentials even after the default gateway mode changes. Offline payment records
  retain an unspecified processor mode. Tests cover partial returns and retained card fees.
- Verified the hosted location is `pathflow-app`, while local development uses `primary-location`.
  Applied and read back the approved sandbox account mapping and disabled subscription billing
  in the existing `pathflow-app` Static Web App settings under the approved Pathflow subscription.
  Read-only SQL tenant lookup confirmed the location. Hosted `/` and `/api/ping` returned HTTP 200
  after the configuration update. Azure resource count, role assignments and budget have zero changes.
- Configured the explicit hosted-compatible sandbox mapping in ignored local settings. Pathflow
  subscription processor integration is deferred by the user. Registration and subscription screens
  explain complimentary access and omit card entry while subscription billing is disabled.

#### Final validation proof

- API regression passed 101 tests with one environment-gated integration skip. The isolated shop
  runner separately passed that API integration.
- Angular unit tests passed all 51 tests. Whole-app statement coverage remains approximately
  10 percent. Critical workflows have targeted API and browser coverage.
- All nine HTTPS production-build authentication tests passed against isolated Functions and storage.
- All 25 shop browser workflow tests passed, including sandbox/live card-field selection,
  refund/void UI, phone leads, quote/invoice identity, scheduling, portal through pickup and scrolling.
- Both public startup/browser tests passed. Production build and deploy-output verification passed.
  Existing component CSS size and Power BI CommonJS optimization warnings remain.
- A real $1.00 sandbox charge used hosted card tokenization and the current payment handlers with
  isolated in-memory invoice, ledger and job records. A real gateway void restored the invoice's
  $1.00 balance. Outbound email/SMS were mocked. Refund settlement paths were tested with mocked
  processor responses. The test records were isolated from application databases.
- Clean API installation and allowlisted packaging passed. All 36 packaged Function entrypoints
  loaded. Packaged payment source files match the current checkout and local settings are excluded.
- Clean web `npm ci` completed with zero reported vulnerabilities. The subsequent production build
  and output verification passed. The local app restarted on Node 22.23.5, with `/`, `/api/ping`
  and `/api/ready` returning HTTP 200 through port 4200.
- Workflow YAML parsing, source whitespace checks and the installed dependency tree passed.

The next release action is deployment of these verified application artifacts, followed by hosted
account sign-in, readiness, gateway connection/default selection and a sandbox invoice smoke test.
The existing infrastructure candidate cutover has its own historical rollout scope below.

### Pre-deployment application audit completed locally on 2026-11-18

Release status remains pending application security and live billing readiness.
This pass reviewed the local release and performed read-only production configuration checks.
The approved Pathflow subscription remains `6c08277d-9b3c-40c6-923b-1c01ca2610a7`.
Infrastructure templates, Azure roles, resource counts, quota and budget have zero changes in this pass.

#### Corrections verified locally

- Password sign-in confirms the server session before completing navigation. Initial anonymous profile
  responses cannot clear a freshly issued cookie or overwrite a newer authentication state.
- Temporary session or profile storage failures return a recoverable error and preserve the cookie.
  Expired sessions trigger a server recheck and a safe local redirect to sign-in.
- The application entry point now loads its configured authentication interceptor. Password recovery
  and invitations use hashed, expiring, single-use reset tokens with atomic consumption and session revocation.
- Protected data checks current active tenant membership and current stored roles. Development identity
  headers require an isolated development runtime and a loopback request. Hosted inventory reads use only
  the authorized tenant partition.
- Federated profile bootstrap issues the app session required by protected staff document endpoints.
  Production-build passkeys use server verification. Browser-seeded development users cannot authenticate
  a production build.
- Local, CI and managed API runtime targets use Node 22. Release deployment downloads the frontend
  and clean API artifacts produced by the regression job. Production dependency advisories are checked
  before artifacts are released.
- The XML-parser dependency was patched and SheetJS was updated to the publisher's pinned 0.20.3 archive.
  Spreadsheet read/write compatibility was verified.
- Subscription form entry cannot activate hosted paid access without a processor transaction. Pending
  billing stays pending and sandbox billing grants access only in isolated development. Hosted forms
  explain that online subscription billing is being configured and omit card entry.

#### Validation proof

- `node --test api/test/*.test.js` passed 95 tests with one environment-gated integration skip.
- `npm run test:shop:isolated` passed the gated API integration and all 24 browser workflow tests.
  This includes quote conversion, invoice identity, scheduling, customer portal through pickup,
  scrolling and mocked gateway charge/reversal behaviors.
- `npm run test:unit:ci` passed all 51 Angular tests. Whole-app statement coverage remains approximately
  10 percent. Additional tests are needed to broaden application coverage.
- `npm run test:auth:production` passed all nine HTTPS production-build browser tests against isolated
  Functions and storage. Secure cookies, reload, interrupted checks, safe redirects, expired sessions,
  reset forms, subscription messaging and server WebAuthn were exercised.
- `npm run build` and `node scripts/verify-deploy-output.mjs` passed. Existing CSS budget, CommonJS
  and Tabler selector optimization warnings remain.
- Clean locked production API dependency installation passed. The allowlisted archive excluded local
  settings and source tests, and all 36 packaged Function entrypoints loaded from fresh dependencies.
- Workflow YAML parsing, SheetJS import/export round trip and source whitespace checks passed.
- `npm run test:e2e:regression` passed both public startup tests. The normal local app was restarted
  under Node 22, and `/`, `/api/ping` and `/api/ready` returned HTTP 200 through port 4200.
- Read-only production checks confirmed canonical HTTPS routing and enabled local/AAD/Google providers.
  The deployed API still returns 404 for `/api/ready` and requires a post-deployment readiness check.

#### Remaining release work

- Upgrade Angular and its build tooling to a supported patched release. The production web dependency
  audit still reports four high and three moderate advisories. The full tooling audit also reports
  critical advisories. The available framework remediation requires a major-version migration.
  API production dependencies report six moderate advisories and zero high or critical advisories.
- Complete live PayLynx invoice payment configuration. The current integration accepts only the isolated
  development sandbox. Hosted live charging, reconciliation and reversals require live configuration
  and verification. Sandbox workflow tests use mocked external processing.
- Complete the Pathflow subscription processor integration and confirmed paid activation. Existing
  card-entry placeholder behavior was corrected, and live recurring subscription charging is pending.
- Verify real hosted account sign-in, invitation/reset email delivery, readiness, permissions and payment
  behavior after a separately prepared deployment. Local tests use synthetic accounts and mocked outbound
  email/SMS. Production configuration reads provide no proof of a real hosted account login.

### Proposed follow-up: configurable SMS reminders (2026-10-14)

Status: Planning — awaiting approval of reminder behavior before implementation.
Modify the existing app, preserving all unrelated work. Add tenant-scoped Admin settings,
durable reminder scheduling and a background Functions worker for unanswered quotes and unpaid invoices.
Proposed defaults: disabled until explicitly enabled; offsets of 24 hours, 3 days and 14 days
from successful initial delivery; business-hours sending in the location time zone.
Require current SMS consent; stop for accepted/declined quotes and paid/void/cancelled invoices.
Use authoritative server state, authenticated Admin access, durable deduplication and send history.
Do not enroll historical documents automatically. Do not mark external checkout handoffs paid.
Validate with mocked outbound messaging, lifecycle/tenant-isolation/retry regressions and UI tests.
No production deployment, live messages or new paid Azure resources in this pass.
Retain the approved Pathflow-only Central US context and $50 monthly target; SMS volume is variable cost.
Confirm reliable invoice settlement state and scheduled-worker hosting before enabling production reminders.

Implementation architecture: existing Angular Admin SMS section and tenant-scoped settings API;
existing Node Functions API and SQL-backed table adapter for enrollment and send-attempt records;
timer worker on the existing dedicated Functions hosting candidate, not a browser timer.
Keep the existing AZCLI/Bicep delivery recipe. Resource inventory for this local implementation:
zero Azure resources provisioned or modified, no quota increase, existing counts unchanged.
Policy/quota and hosted timer compatibility checks belong to a separately validated deployment.
Admin controls: independent quote/invoice enable switches, editable day offsets and templates,
location time zone and send window, plus reminder history and failed/uncertain delivery visibility.
Default schedule is cumulative days 1, 3, 14 after initial successful send, not gaps between reminders.
Only newly sent documents enroll by default. Recheck consent and document state immediately before send;
skip obsolete reminders rather than sending a catch-up burst after downtime. Treat uncertain provider
outcomes conservatively rather than blindly retrying and duplicating messages.
Execution: implement settings/access validation, enroll successful sends, implement worker/state checks,
add Admin controls/history, then test opt-out, terminal states, overlapping runs, failures, and tenant isolation.
Production-facing feature, initially validated only against isolated development data and mocked SMS.

### Approved follow-up: quote authorization and payment correctness

User approved fixing both release blockers. Scope: verified session/principal and tenant membership for staff quote
operations; quote-bound public tokens for customer responses; no paid state or receipt for external checkout handoff.
Add negative/positive regression tests and run local checks. No production deployment or routing change in this pass.

Follow-up implementation completed locally (2026-10-09). Quote authorization now uses verified app sessions,
active tenant membership and token-bound public actions; caller identity/principal headers do not grant access.
Anonymous token listing and cross-tenant mutations rejected. Stored customer details remain authoritative.
Both email and SMS publish tokenized quote links before sending. Tokenless older links must be resent.
External checkout returns awaiting-confirmation without paid mutations, receipts or invoice-response capture.
URL paid flags do not confirm payment; direct charges require success and transaction ID.
Verification: API 61 passed/1 integration skipped; Angular 46 passed; browser startup passed;
production build/artifact integrity passed with existing size/CommonJS warnings. Live isolated quote flow passed
after restarting the stale local Functions host. Synthetic QA tenants only, no production records changed.
Application follow-up status: Ready for Validation before any future Azure deployment. The hosted candidate
still runs the previous artifact; this is not a production validation/deployment claim.

The user has requested implementation of the October 9 Azure comparison recommendations.
The historical validation below applies only to the earlier application-only work, not this rollout.

- Repair SQL pool recovery and push tenant filters into parameterized SQL, with regressions.
- Select an always-available SQL configuration after checking current storage and pricing.
- Prepare an always-running API candidate with health probes; validate before production cutover.
- Separate local development data and outbound messaging from production.
- Add production telemetry, alerts, staged checks, and rollback procedures.
- Retain production data and existing resources; do not modify Hitch-Heroes.

Proposed context: Pathflow subscription `6c08277d-9b3c-40c6-923b-1c01ca2610a7`, Central US.
User confirmed Pathflow/Central US and a $50/month target, with approval required before exceeding it.
User explicitly approved Linux B1 Functions + SQL S0 + SWA Standard, including permanent loss
of this database's free offer and possible brief connection interruption during conversion.

### Rollout stages

1. Validate and convert the existing SQL database in place to S0; no authentication/data changes.
2. Provision a B1 always-on Functions candidate, monitoring, health checks, and isolated development data.
3. Validate the candidate with isolated data, then deploy and link the production API through SWA Standard.
4. Verify production flows, telemetry, rollback, and repeatable release checks.

### Recipe and budget

AZCLI with checked-in Bicep and explicit subscription arguments; preserve the existing GitHub delivery path.
Current retail USD pricing: B1 Linux $0.018/hour (~$13.14/730 hours), S0 $0.4839/day
(~$15 for 31 days), SWA Standard $9/month. Core fixed estimate ~$37/month before tax;
development and ancillary services must fit the remaining budget. No claim of a hard Azure spending cap.
Budget stage: one free subscription budget, $50/month, owner email notifications at 80%/100% actual and
100% forecast. No service shutdown actions. Uses the signed-in Pathflow owner's verified email.
Azure validation skill proof (2026-10-09): Bicep compiled during ARM validation; subscription validation
Succeeded/error null, what-if Succeeded and showed only creation of `pathflow-monthly-50`. No role changes,
no deletes, no hosting changes, no paid-resource quota consumed. Azure CLI authentication and explicit
Pathflow subscription verified. Budget stage approved for execution with Azure deployment skill.
Do not simply disable serverless SQL auto-pause: at $0.62611/vCore-hour and minimum 0.5 vCore,
continuous compute would exceed the approved budget even before other services/free allowance adjustments.

### Stage 1 provisioning and safety

Zero new resources. One existing database changes SKU; count remains one user database.
No new quota required. Production server, collation, local backup redundancy,
and connection strings are preserved. No rows are modified/deleted. SQL auth is unchanged.
Policy assignments returned none. B1 future-stage regional quota: limit 30, usage 0.
SQL conversion is gated by Bicep compilation, ARM validation and what-if inspection.
Rollback can return to a paid SQL tier, but cannot restore free-offer eligibility.
No frontend/API cutover is included in stage 1; later stages require their own validation proof.

### Current implementation and validation proof

- SQL read-recovery, parameterized key filtering, and merge-failure safety implemented locally.
- Deployment workflow now depends on the reusable regression gate.
- `node --test api/test/sql-reliability.test.js`: 10 passed (2026-10-09).
- `npm run test:api`: 43 passed / 1 integration skipped before the final two SQL tests were added.
- `git diff --check`: passed (2026-10-09).
- Azure validation skill proof (2026-10-09): `az bicep build --file infra/sql-production.bicep --stdout` passed;
  `az deployment group validate --subscription 6c08277d-9b3c-40c6-923b-1c01ca2610a7 -g DefaultResourceGroup-CUS --template-file infra/sql-production.bicep`
  returned Succeeded/error null. `az deployment group what-if` for the same scope showed only the approved database
  modification (S0 SKU, free offer disabled); server/master ignored, no deletes or data changes.
- Static role verification: no role/identity/authentication changes in the stage 1 template.
- Existing SQL short-term backup policy verified: 7-day PITR retention, differential backup interval 12 hours.
- Angular unit regression: 36 passed (2026-10-09).
- Microsoft.Quota provider registration was enabled for capacity checks before paid provisioning.
- First SQL deployment rejected with InvalidMaxSizeTierCombination: Standard does not accept 32 GiB.
  Read-back confirmed original serverless SKU, free offer and Online state unchanged.
  Corrected template uses the included S0 250 GiB limit, without an extra storage charge.
  Corrected template compiled; ARM validation Succeeded and what-if showed only the database SKU,
  included size limit, and free-offer changes (2026-10-09). Azure validation skill approved stage 1 retry.
  Deployment `pathflow-sql-always-on-20261009` subsequently returned Succeeded/error null.
- Live SQL read-back: Online, Standard S0/10 DTU, no auto-pause. Read-only connection/SELECT check
  took 839 ms; subsequent tenant count queries took 155/64/64 ms. Existing data remained accessible.
- Final API regression after dependency updates and readiness syntax repair: 46 passed, 1 skipped.

### Stage 2 development database validation proof (2026-10-09)

- Azure CLI authenticated to explicitly selected Pathflow scope; existing SQL server retained.
- Bicep compilation and ARM group validation of `infra/sql-development.bicep` succeeded.
- What-if showed only creation of empty `pathflow-dev` (Basic, 5 DTU, 2 GiB); production/master/server ignored.
- No credential, role, policy, or production data changes in this template. No container build applies.
- SQL quota API unsupported; ARM validation passed. One additional database, two user databases total.
- Estimated Basic cost ~$5/month fits the approved target alongside B1/S0/SWA, subject to variable usage.
- Development credential scoping, outbound mocks, and application verification remain separate gates.

### Stage 2 validation proof and capacity (Azure validation skill, 2026-10-09)

- Source: Azure-Samples/functions-quickstart-javascript-azd v1.0.0, discovered via official Functions manifest.
  Adapted user-approved B1/Always On/Node 22; preserved UAMI storage and AAD-only telemetry patterns.
- `az bicep build --file infra/hosting/main.bicep --stdout`: passed; upstream optional-VNet/unused-parameter warnings.
- `az deployment sub validate --location centralus --template-file infra/hosting/main.bicep --parameters infra/hosting/production.parameters.json`
  with explicit Pathflow subscription: Succeeded/error null, including final existing-RG adjustment.
- Subscription what-if: new B1 plan, Function App, UAMI, runtime storage, Log Analytics and App Insights;
  existing production services ignored, no deletes. RG changed to existing declaration to preserve its tags.
  Two computed role assignments not expanded by what-if: statically reviewed resource-scoped
  Storage Blob Data Owner on new runtime storage and Monitoring Metrics Publisher on new App Insights.
- B1 quota: 0 used / 30 allowed, 1 planned. Storage: 1 used / 250 allowed, 1 planned (2 total).
- New workspace and Insights component: 0 existing / 1 planned each; quota API unsupported (BadRequest),
  official Azure Monitor limits and successful ARM validation used. Resource group remains far below ARM limits.
- Candidate ingress limited to operator IP, no production SQL settings supplied, SMS/email mock.
- Workspace: 30-day retention; 0.05 GB/day safety cap plus host sampling. Cap is not a guaranteed billing limit.
- API/frontend tests and production build passed; auth browser regression passed; deploy-output integrity passed.
- This validation does not authorize claiming the application cutover complete. Candidate deployment/data/identity
  checks and production routing validation remain mandatory before linking production traffic.
- Candidate infrastructure deployment succeeded. Read-back confirms Always On, NODE|22, /api/ping,
  default-deny ingress and the operator-only allow rule. UAMI live roles match resource-scoped
  Storage Blob Data Owner and Monitoring Metrics Publisher requirements.
- Candidate application validation: 48 API tests passed, one integration test skipped. Function-entrypoint
  and readiness success/failure/privacy tests pass. Allowlist ZIP excludes local settings, backups and dependencies.
  Candidate-only application deployment is validated; no SQL credentials/live outbound settings supplied yet.
- Development database read-back: Basic/5 DTU, Online. No production data copied.
- Isolated development login verified in `pathflow-dev`; same credentials denied by production.
  Local settings switched to dev SQL and Azurite, with all live integration secrets removed and SMS/email mocked.
  Previous settings preserved in a mode-0600 ignored backup. Local host restarted; frontend-proxied
  /api/ping and /api/ready both pass (41/83 ms). Startup guards have eight passing regression cases.
- Budget deployment succeeded and read-back confirms $50 Monthly with 80/100 actual and 100 forecast alerts.
- User-approved SWA SKU upgrade completed in place: Standard. Production frontend and existing managed API
  still return HTTP 200; no backend link changed.
- Remote candidate build hit gateway timeout; no production impact. Diagnostics show Oryx build incomplete.
  Recovery artifact: clean `npm ci --omit=dev --ignore-scripts` from exact lockfile, checked for native binaries,
  packaged with allowlisted functions; no local settings/backups. Candidate remote-build flags disabled/read back.
  API tests 56 passed/1 skipped, Angular tests 36 passed, local smoke passed. This validates candidate-only
  prebuilt deployment recovery, not production cutover. Monitoring ingestion and hosted readiness still pending.
- Candidate diagnostics: B1 CPU averages 90–99% while Oryx builds, memory 68–80%; SCM requests time out
  or return 503/429. Production is unaffected. Stop/start recovery is limited to this isolated candidate,
  followed by a prebuilt artifact, without increasing the approved SKU/budget.
- Recovery: private prebuilt ZIP uploaded to the existing deployment container after a temporary container-scoped
  uploader grant; grant removed after upload. Candidate package URL and managed-identity resource ID read back.
  Remote build disabled. Trigger synchronization returned host InternalServerError; latest host traces show
  zero functions loaded. Candidate smoke still fails; production cutover is NOT validated or performed.
  Application Insights ingestion works (host traces received). Candidate-only stop/start/restart attempted.
  Worker reboot API rejected the request (no successful reboot). No paid SKU increase was performed.
- Separate isolated local invoice-to-parts workflow passed in 17.8 seconds. Synthetic QA tenant only.
  Production /api/ping returned HTTP 200 after changes. No source commit/push or production application deployment.
- Subsequent private-package startup succeeded without increasing B1. Hosted smoke: initial ping 12483 ms /
  ready 2202 ms, repeated warm ping 342 ms / ready 218 ms. Earlier startup failures are retained above as history.
  Candidate is still dev-backed, mock-outbound, operator-IP restricted. No production backend link changed.
- Cutover now held for application release compatibility/security review: quote-response resolveActor trusts
  caller-provided identity and public accept/decline lacks token validation; external payment-link branch marks
  invoices paid without processor confirmation. These are separate application release blockers, not evidence
  that the hosting migration requires a larger paid SKU. Scope decision needed before broader business-flow changes.

## Historical application-only plan and validation

Generated: 2026-10-08

## 1. Project Overview

**Goal:** Harden the production authentication startup path, add privacy-safe performance telemetry, and add repeatable regression checks that gate deployable builds.

**Path:** Modify existing application.

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Production candidate |
| Scale | Small, pre-launch |
| Budget | Cost-optimized; retain the current topology |
| Subscription | Pathflow (`6c08277d-9b3c-40c6-923b-1c01ca2610a7`) |
| Location | Central US |
| Compliance | No credentials, email addresses, biometric data, or passkey identifiers in telemetry |

The subscription and location are the existing Pathflow production context confirmed during diagnosis. No Azure resources will be created or changed in this implementation pass.

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| Web | SPA frontend | Angular 19 / Ionic 8 | `src/` |
| API | Serverless HTTP API | Node.js Azure Functions | `api/` |
| Browser regression | End-to-end tests | Playwright | `e2e/` |
| CI/QA | Automation | GitHub Actions | `.github/workflows/` |

## 4. Recipe Selection

**Selected:** Existing GitHub/Azure Static Web Apps delivery path; application-only modification.

**Rationale:** The hosted topology already exists and is healthy. Adding a parallel AZD/IaC deployment path during an auth regression fix would create deployment drift. Optional Azure Monitor export will activate when `APPLICATIONINSIGHTS_CONNECTION_STRING` is present.

## 5. Architecture

**Stack:** Azure Static Web Apps with managed Node.js Functions.

| Component | Azure Service | SKU |
|-----------|---------------|-----|
| Angular SPA | Azure Static Web Apps | Existing Free tier |
| HTTP API | Static Web Apps managed Functions | Existing managed tier |
| Entity/auth data | Azure Storage and existing Azure SQL configuration | Existing |
| Telemetry export | Azure Monitor / Application Insights connection string | Optional, existing-or-later resource |

## 6. Provisioning Limit Checklist

| Resource Type | Number to Deploy | Total After Deployment | Limit/Quota | Notes |
|---------------|------------------|------------------------|-------------|-------|
| Azure resources | 0 | Unchanged | Not applicable | Code/config preparation only; no provisioning in this pass |

**Status:** No quota or capacity change.

## 7. Execution Checklist

### Planning

- [x] Analyze workspace
- [x] Gather requirements from the approved five-item scope
- [x] Confirm existing Azure subscription and location
- [x] Scan codebase and existing QA workflow
- [x] Select the existing delivery recipe
- [x] Plan architecture
- [x] User approved this scope

### Implementation

- [x] Replace full-page login navigation with Angular Router navigation
- [x] Show remembered biometric prompt before auth bootstrap completes
- [x] Skip session storage initialization when no session token exists
- [x] Parallelize remote auth bootstrap and cache safe runtime configuration
- [x] Add privacy-safe client timing markers and optional Application Insights export
- [x] Add unit, API, browser, and CI regression checks
- [x] Add widget-lead handler and Function entrypoint regressions
- [x] Update status to `Ready for Validation`

### Validation

- [x] Invoke Azure validation workflow
- [x] API tests pass
- [x] Angular unit tests pass
- [x] Production build passes
- [x] Deploy-output integrity check passes
- [x] Focused browser regression passes
- [x] Hosted smoke suite compiles and lists successfully

## 8. Validation Proof

| Check | Command Run | Result | Timestamp |
|-------|-------------|--------|-----------|
| API regression | `npm run test:api` | Pass: 29 passed, 1 local seeded integration skipped | 2026-10-08 |
| Live local widget smoke | `POST http://localhost:7071/api/widget/lead` with SMS opt-in | Pass: HTTP 200 through storage, lead, and SMS-confirmation path | 2026-10-08 |
| Angular unit regression | `PATH="$PWD/node_modules/node/bin:$PATH" npm run test:unit:ci` | Pass: 14 passed | 2026-10-08 |
| Production build | `PATH="$PWD/node_modules/node/bin:$PATH" npm run build` | Pass with existing size/CommonJS warnings | 2026-10-08 |
| Deploy artifact integrity | `npm run verify:deploy-output` | Pass | 2026-10-08 |
| Auth startup browser regression | `PATH="$PWD/node_modules/node/bin:$PATH" npm run test:e2e:regression` | Pass: 1 passed | 2026-10-08 |
| Hosted suite discovery | `PATH="$PWD/node_modules/node/bin:$PATH" npx --no-install playwright test --list -c playwright.hosted.config.ts` | Pass: 14 hosted checks discovered | 2026-10-08 |
| Working-tree formatting | `git diff --check` | Pass | 2026-10-08 |

## Role Assignment Verification

- Status: Not applicable for this application-only change.
- Identities checked: No new managed identities or infrastructure definitions were introduced.
- Roles confirmed: No RBAC assignments were added or changed.
- Issues: None.

## 9. Files to Generate or Modify

| File area | Purpose | Status |
|-----------|---------|--------|
| `.azure/deployment-plan.md` | Execution and validation record | Complete |
| Angular auth/home/telemetry files | Startup hardening and client timing | Complete |
| `api/_shared/auth.js` | Anonymous session fast path | Complete |
| `api/telemetry/` | Structured telemetry ingestion/export | Complete |
| Unit/API/Playwright tests | Regression coverage | Complete |
| GitHub workflow and package scripts | Repeatable deploy gate | Complete |

## 10. Deployment

No production deployment is authorized by this task. Deployment remains a later explicit step after validation.
