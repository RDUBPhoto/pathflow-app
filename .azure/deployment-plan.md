# Azure Deployment Plan

> **Status:** Vehicle intake/tabs and production reset verified; final appointment vehicle snapshots validated locally and releasing.

## Current rollout scope

### Multiple vehicles and production fresh start authorized on 2026-11-19

#### Release and reset proof

- Follow-through inspection found calendar entries, appointment messages and schedule-derived
  parts needs still used the customer primary vehicle. Linked paid-job scheduling now persists
  the invoice/job vehicle snapshot and vehicle ID. Rescheduling retains it, and calendar views,
  Google/Outlook calendar links, email details and parts needs prefer that snapshot. Customer
  and quote search includes secondary vehicle descriptions and VINs.
- Added an API regression for a two-vehicle customer's linked appointment/parts needs, including
  rescheduling; unit checks for shared appointment/calendar details; and production-browser
  checks for secondary-vehicle search and its calendar event. Local production build, all API
  tests, 54 Angular tests and 12 production browser tests passed. Release/CI proof to follow.
- The production database remains cleared. This follow-up uses isolated test storage; no further
  production CRM data reset is planned. Keep unrelated local payment/receipt work unstaged.


- Final product release `fdfaf2ede9289b8ddd1dc9f4d5f01f21e35f8a70` deployed successfully in
  run 44557326587. CI passed 113 API tests (one existing skip), 52 Angular tests, two startup,
  12 production browser and 25 shop workflow tests. Hosted frontend matched its tested artifact.
- Hosted verification at 2026-11-19T15:48:33.798Z reused the actual pre-reset browser
  storage. Customers, documents and work items returned empty; dashboard and Jobs were empty;
  all customer/sales/quote/invoice/workflow report metrics were zero. The old saved portal link
  returned 404, and both stale document uploads and stale dashboard card creation returned
  BUSINESS_DATA_RESET (409). PayLynx stayed connected in sandbox/test mode and SMS stayed in
  Azure mode with the assigned sender number. No payment or message was sent by these checks.
- The transient cards had already been pruned after cache synchronization. Backed up and removed
  six orphaned post-reset history events in a scoped transaction. A later independent SQL read
  found zero rows across the complete customer/workflow allowlist; the original recovery gzip
  checksum still matched. Existing inventory, both vendors and all staff access remain.
- Removed the temporary verification account and sessions at 2026-11-19T15:49:08.681Z.
  The recovery manifest includes the scoped cleanup, checksum and final hosted/SQL proof.
- A duplicate standalone CI run exposed test setup timing: initial legitimate card creation
  could be counted as post-reset activity. Commit `aa1c782` waits for initial card creation
  before installing reset interception. All 12 browser tests passed locally with that correction;
  both clean CI reruns passed (44558640351 and 44558639815), and it deployed successfully. This commit changes only the test fixture, not product code.


- Vehicle release `1d2b95d0b99224be798accdf7c192de9315ae167` deployed successfully through
  GitHub Actions run 44555013343. CI: 113 API tests passed with one existing skip, 51 Angular,
  two startup browser, 12 production authentication/vehicle/reset browser and 25 shop workflow
  tests passed. Both dependency security audits reported zero vulnerabilities.
- Hosted index exactly matched the tested artifact. Real hosted sign-in, returning website
  intake, preservation of the original vehicle, selection of the new vehicle for a quote,
  independent tab edits and persistence after reload passed at 2026-11-19T15:34:36.958Z.
  Only synthetic QA contact data was used; no customer SMS/email was requested by this check.
- At 2026-11-19T15:35:15.410Z the authorized SQL reset committed: 6,571 customer/workflow rows
  were backed up and cleared, including 5,209 customer records (one from the hosted check).
  The private gzip backup was verified before deleting. All protected entity fingerprints
  matched inside the serializable transaction, including 6,671 inventory rows, both vendors,
  existing accounts and settings. The cache generation marker was written atomically.
- The real old-browser verification caught a dashboard race: cached documents could trigger
  creation of a missing card before the document reset response arrived. The document itself
  stayed deleted, but one empty quote card reappeared. Follow-up hardening makes reconciliation
  wait for document synchronization and rejects cards for absent documents in reset workspaces
  on the server. A delayed-response browser test and a dashboard loading unit test cover it.
- Remove only recreated cards referencing the backed-up cleared documents and their associated
  events after deploying this guard. Preserve any new legitimate records created since reset.
  Keep these cleanup rows alongside the original private backup for recovery/audit.


- The user explicitly requested preserving a returning website customer's existing vehicle,
  adding the new vehicle separately with profile tabs, and clearing production customers,
  invoices, quotes and related business activity after deploying the fix.
- Preserve all staff accounts, passwords, passkeys, sessions, business settings, SMS routing,
  gateway credentials, lanes, inventory/catalog/stock, vendors, connectors and templates.
  Clear only the explicit customer/workflow table allowlist in the existing SQL catalog,
  including historical imported partitions. No schema, infrastructure or provider transactions
  are deleted or modified. Inventory quantities remain unchanged.
- Vehicle collections migrate legacy vehicle fields on read. The primary vehicle remains a
  backward-compatible projection. Website intake adds/reuses a matching vehicle without
  overwriting the old one. Each lead and document carries the selected vehicle ID and snapshot.
  Profile tabs support independent editing, adding, removal and primary selection, and stale
  VIN lookups cannot overwrite a different selected vehicle. Quotes preserve their selected
  vehicle when converted into invoices.
- Reset protection adds a tenant-specific data generation marker to document synchronization.
  Old browser caches are discarded after reset; outdated clients cannot upload cleared drafts.
  Server collections also remove cached documents that are no longer present.
- Local validation: production build passed; Angular 51/51, API 113 passed with one existing
  environment-dependent skip. The production HTTPS browser suite covers returning-customer
  vehicle intake, correct dashboard/quote selection, separate vehicle tab edits, adding/removing
  vehicles, and discarding cached documents after a business reset, alongside the ten existing
  authentication/invitation checks. Final run and CI proof to follow.
- Reset preflight discovered 5,208 customers and older transactional/import/test records.
  Prepare a private verified compressed recovery backup, then acquire a serializable SQL lock,
  recheck the sole registered tenant, delete only the allowlisted transaction rows, set the
  cache reset marker and verify protected entity fingerprints unchanged before committing.
  Abort/roll back if scope, backup verification or preservation checks fail.
- Release through the existing GitHub regression/deployment gate to the existing Standard
  Static Web App and managed Functions. No Azure resource, SKU, role, subscription or spending
  change. Verify the hosted vehicle journey before the reset, then empty APIs and UI afterwards.


### Exodus production SMS verified on 2026-11-19

- Reused the existing production business `pathflow-app`, as confirmed by the user. The workspace
  and business display name are now Exodus 4x4; the internal tenant ID and existing records remain.
- Assigned existing Azure number `+18338978049` to this tenant and corrected the global phone
  lookup that previously pointed to unregistered legacy partition `primary-location`.
- Copied ACS credentials securely from the existing Azure resource into production settings and
  enabled `SMS_MODE=azure`. No global sender fallback was enabled. The development app remains
  isolated in mock mode. All unrelated hosted settings were read back and confirmed unchanged.
- The existing Event Grid subscription still delivers SMS received and SMS delivery report events
  to the production SMS endpoint. Added a random shared secret as a secret static
  `x-pathflow-sms-key` delivery header and matching hosted `SMS_WEBHOOK_KEY`. Azure reports
  successful provisioning and secret storage. Requests without webhook authentication return 401.
  The CLI update required restating the existing HTTPS endpoint when adding a delivery header.
- Detected one simulated response from a warm pre-change worker during settings propagation.
  It was not treated as live delivery. Removed only that exact simulated QA record, confirmed
  live Azure status across fresh requests, and sent one actual carrier test message.
- Real SMS gateway message `1b81b21c-22c3-406c-9cb2-811bc3226c10` was accepted without simulation and its
  authenticated delivery report recorded Delivered, with Azure detail 2000 Message Delivered
  Successfully. The user independently confirmed receiving the message on their supplied phone.
- The user's real reply SMS Ready arrived in the Exodus production partition, matched the existing
  Robert customer conversation, and was confirmed at `2026-11-19T14:59:06.419Z`.
- Hosted browser verification confirmed the sender number and label, azure mode and live-ready
  status. The actual outgoing test and incoming reply are visible together in Messages Hub.
  UI verification completed at `2026-11-19T15:00:04.816Z`.
- Removed the temporary tenant-scoped verification account and its sessions, with account deletion
  read back, at `2026-11-19T15:00:41.987Z`. Kept the genuine test SMS and user reply in the existing
  customer conversation. Hosted ping and database readiness remain healthy.
- No source code, dependency, Azure role, resource count, SKU or recurring number purchase changed.
  All five focused SMS handler and SDK tests passed. The existing deployed application was used.
- Automatic number assignment on future business signup is a follow-up. It needs dedicated-number
  reservation or acquisition, idempotent tenant assignment, approval tracking and status handling.
  Existing ACS customer resources with phone numbers can acquire numbers during the transition,
  but Microsoft has announced ACS SMS and direct number management retirement on September 30,
  2028. Keep provider choice separate from onboarding before implementing automatic purchases.
  References: https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide#acs-sms
  and https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/telephony/get-phone-number.

### Exodus production SMS configuration authorized on 2026-11-19

The user authorized using the existing `pathflow-app` production business for Exodus 4x4 and
testing SMS delivery to their supplied mobile number. Reuse the existing Communication Services
resource `acs-pathflow-dev-us` and purchased number `+18338978049` in the approved Pathflow
subscription and resource group. No new number, resource, SKU or recurring commitment is requested.

- Current production SMS mode and ACS credentials are unset. Current development settings use
  isolated mock messaging. Azure confirms the purchased toll-free number supports inbound and
  outbound SMS. The existing Event Grid subscription routes both SMS received and delivery reports
  to `https://www.pathflow-app.com/api/sms` and is provisioned successfully.
- A stale sender lookup points to the unregistered legacy `primary-location` partition. Assign
  the number specifically to `pathflow-app` and correct the phone-to-tenant lookup. Keep the
  internal tenant ID and existing business records. Name this business Exodus 4x4 for SMS branding.
- Copy the existing ACS credentials securely into hosted app settings, enable Azure SMS and
  configure a random shared webhook secret. Add the matching secret header to the existing
  Event Grid subscription. Preserve other application settings and event subscription behavior.
  Keep the sender number tenant-specific; no shared global sender fallback is enabled.
- Preflight validation: current application source is the tested deployed invitation release.
  Verify focused SMS handler/SDK tests, Azure number ownership and capabilities, live app/API/SQL
  health and the exact tenant/sender records before applying configuration. This change introduces
  no Azure role assignments or application code changes.
- Validation proof on 2026-11-19: all five focused SMS webhook/SDK tests passed. Hosted JSON
  health checks passed (`/api/ping` 369 ms, `/api/ready` 82 ms, SQL ready). Azure CLI confirmed
  existing number ownership and two-way capabilities, an active event subscription with both
  required SMS event types, and the exact stale sender lookup. Production SQL tenant routing is
  disabled, so sender and phone lookup records currently reside in the production catalog.
  The user confirmed reusing the existing business and supplied the test recipient number.
  All configuration preflight checks passed; no build, dependency, infrastructure or RBAC changes
  are required for this configuration-only rollout. Azure validation records Validated status.
- Verify hosted config, one real SMS to the user, carrier delivery report persistence, and incoming
  reply routing if the user replies. Remove the temporary verification login and sessions.
- Future signup automation is a subsequent implementation: reserve or acquire a dedicated number,
  persist a unique tenant mapping, track verification and enable messaging after approval. Current
  Azure documentation also announces ACS SMS and direct number management retirement on September
  30, 2028; keep provider selection and number assignment separate when implementing that workflow.

### Production invitation verification completed on 2026-11-19

- Deployed commit `110e255fd79af6c6dec89bb8d89fc3163dbd1eff` through successful release
  https://github.com/RDUBPhoto/pathflow-app/actions/runs/44543330887. The standalone regression
  run https://github.com/RDUBPhoto/pathflow-app/actions/runs/44543331355 also passed.
- Cloud gate passed 105 API tests, 51 Angular tests, two startup browser tests, 10 secure
  production-build authentication browser tests, 25 shop browser tests and the isolated API
  integration. Both dependency audits, build, deploy verifier and clean package checks passed.
- Hosted frontend matched the tested CI artifact, SHA256
  `f25399148b6629ffa36c2ed5c6e8cd22c5ae74b910a12981bab6c31bf514d55f`.
  Hosted ping passed in 345 ms and SQL readiness in 123 ms.
- Used the hosted Add User UI with a temporary tenant-scoped QA admin. SendGrid accepted the
  invitation; the UI showed the saved Invited user, three-day expiry and Resend invite.
- Verified actual delivery to the connected Gmail inbox at `2026-11-19T14:30:28+00:00`.
  Read the received email, followed its genuine SendGrid-tracked link and confirmed it resolved
  to the production password setup page. The email states the 72-hour expiry.
- SQL read-back confirmed the persisted invitation purpose and 72-hour expiry
  (expires `2026-11-22T14:30:27.914Z`). Password setup activated and verified the
  test user. The hosted admin list changed from Invited/Resend invite to Active/Reset password.
- The new user signed in with its selected password, received a Secure/HttpOnly/SameSite=Lax
  session cookie and remained signed in after reload. Its access was limited to the invited
  tenant; unassigned-tenant API requests returned 403. Replaying the consumed email token returned
  400 invalid/expired. Verification completed at `2026-11-19T14:31:45.921Z`.
- Deleted both exact temporary QA identities, their sessions and password setup tokens
  (7 records). Account deletion was confirmed by read-back; cleanup completed
  at `2026-11-19T14:32:13.749Z`. Existing staff accounts and passwords were not modified.
- The new 72-hour expiry applies to newly issued or resent invitations. Ordinary password resets
  retain one-hour expiry. Historical tokens are not extended. No infrastructure, RBAC, billing,
  payment configuration or resource-cost changes were made.

### Invitation delivery release validated on 2026-11-19

The user authorized fixing invitation email confirmation, extending new invitation links to three
days and verifying actual email receipt, password setup and login in production. This is an
application-only follow-up to the existing `pathflow-app` Static Web App deployment. The approved
Pathflow subscription, resource group, managed API and CI/CD recipe below remain the target.

- Invitations return success only after the configured email provider accepts the message.
  Failed delivery returns HTTP 503 with an accurate saved-user message and the current user list.
  The UI shows the pending user, offers Resend invite and clears stale success messages.
- New and resent invitation tokens last 72 hours and remain single-use. Ordinary reset tokens
  retain their one-hour lifetime. Invitation emails and the admin UI state the three-day lifetime.
- Fixed admin password reset emails that previously built links without issuing a token.
  Authenticated admin reset requests also report email-send errors accurately.
- Validation proof: `npm run test:api` passed 105 tests with one environment-gated integration skip;
  `npm run test:unit:ci` passed all 51; `npm run test:auth:production` passed all 10 browser tests,
  including failure display and resend. `npm run build`, `npm run verify:deploy-output` and
  source whitespace checks passed on 2026-11-19. Both dependency audits reported zero vulnerabilities.
- Tests prove 48-hour-old invitations work, 73-hour-old invitations expire, ordinary password
  resets still expire after one hour, used tokens cannot be replayed, membership activates only
  in the invited shop, and provider rejection cannot be reported as email success.
- Static role verification: this release changes zero infrastructure or Azure RBAC assignments.
  Read-only Azure lookup confirmed the existing Standard Static Web App and hostname. All
  application validation checks passed; the Azure validation workflow records Validated status.
- Production verification will use a temporary tenant-scoped QA admin and a unique plus-address
  on the user's connected Gmail inbox. Verify actual receipt, the email's setup link, password
  creation, secure login, membership, reload and token replay rejection. Remove exact QA identities,
  sessions and reset tokens after verification. No existing staff passwords will be changed.

### Hosted deployment completed on 2026-11-18

- Hosted site: https://www.pathflow-app.com. Existing Azure Static Web App and managed API retained.
- Deployed application commit: `843019f52610acce5a4ea081893d5cc7e6a4b028`.
- Successful release workflow: https://github.com/RDUBPhoto/pathflow-app/actions/runs/44391461825.
- Linux regression gate passed 101 API tests, 51 Angular unit tests, two startup browser tests,
  nine HTTPS authentication browser tests and 25 shop browser tests. The environment-gated API
  integration also passed separately in the isolated shop runner. One ordinary API integration
  discovery was skipped as designed. Security audits, production build, artifact verification
  and clean API packaging passed. All release jobs completed successfully.
- Pinned release runners to Ubuntu 24.04 after Ubuntu latest moved beyond the browser dependency
  support matrix. A slow Ubuntu mirror delayed dependency downloads. The successful release kept
  the complete regression gate. A redundant standalone run was canceled to avoid duplicate work.
- Hosted frontend SHA256 exactly matches the tested CI artifact:
  `9f70c2885b1a872e05314c9a0ce716e7f4ef3b74664686e294fc99ed194f7678`.
- Hosted JSON health checks passed: `/api/ping` in 807 ms and `/api/ready` in 149 ms,
  with database readiness confirmed. Hosted auth config confirms password login enabled and
  subscription charging disabled.
- A temporary tenant-scoped Admin account signed in through the hosted login page. Verified
  Secure, HttpOnly and SameSite=Lax session cookie flags, page reload persistence, complimentary
  workspace access and rejection of an unassigned tenant with HTTP 403.
- PayLynx sandbox account connection validation passed and PayLynx test mode is now the default
  hosted invoice provider for `pathflow-app`. Other existing provider settings were retained.
- An anonymous customer checkout used the hosted PayLynx card iframe and tokenized test card.
  Confirmed a real $1.00 sandbox payment, gateway reference `1437234`, with no raw
  card number or CVV sent to Pathflow. The customer confirmation displayed $1.00 paid.
- The hosted staff invoice UI successfully voided that payment. After reloading both staff and
  customer views, the invoice showed $0.00 paid and $1.00 due. Verification finished at
  `2026-11-18T20:45:03.761Z`.
- Removed the temporary account, its 1 session and all 10 test invoice-related
  records, including the synthetic job, ledger entries and notifications. Read-back confirmed
  deletion. Cleanup completed at `2026-11-18T20:45:20.382Z`. No real customer email or SMS was sent.
- No live-money transaction or new Azure resource, role assignment, SKU or budget change occurred.
  Subscription charging remains deferred. Real settled-refund processing was not exercised by
  this hosted smoke test; this verification covered charge and void as requested.

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
