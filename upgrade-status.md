# Pathflow Azure upgrade — 2026-10-09

Scope: Pathflow subscription only (`6c08277d-9b3c-40c6-923b-1c01ca2610a7`), Central US.
Hitch-Heroes has not been changed. User-approved target is $50/month; no higher paid tier is authorized.

## Completed and verified

- Existing production SQL converted to Standard S0, Online, no serverless auto-pause. Data and login unchanged.
- Static Web Apps upgraded to Standard. Existing production frontend and managed API still serve requests.
- B1 Linux/Node 22/Always On candidate created; ingress restricted to the operator IP.
- App Insights and Log Analytics created; managed-identity telemetry is arriving. 30-day retention,
  0.05 GB/day ingestion safety cap. Operational incident alerts are not yet configured.
- $50 monthly subscription budget with actual 80%/100% and forecast 100% email alerts.
- Empty Basic development database created. Dev-only login verified; production access denied.
- Local settings isolated, live integrations removed, email/SMS mocked, Azurite selected, host restarted.
  Old settings are preserved in an ignored, restricted backup. Local public links now point to localhost.
- SQL recovery/filtering safeguards, readiness tests, development startup guards and CI regression gate added.
- 56 API tests passed, one integration test skipped; 36 Angular tests passed; browser startup regression passed;
  production build and artifact checks passed. Build-size warnings and nine moderate API audit findings remain.
- The otherwise-skipped invoice-to-parts integration test was then run separately against the isolated local
  host: passed in 17.8 seconds, covering invoice processing, purchase orders, partial/full receiving and duplicates.
  It left synthetic data in its own QA tenant in the development database; no production data was touched.

## Cutover gate — not complete

The new API has NOT been linked to production. The production frontend/application code has NOT been published.
Initial Oryx deployment timed out, with B1 CPU 90–99% and SCM 503/timeouts. This is build-time evidence,
not proof that B1 cannot run the workload. A self-contained artifact has been uploaded privately:
`pathflow-prebuilt-20261009.zip`, using the existing package container. Temporary uploader permission removed.
The candidate uses its managed identity to read the package; remote build is disabled. Hosted readiness
subsequently passed: warm ping 342 ms, database readiness 218 ms. No larger SKU was needed. Earlier failed
startup checks are documented in the deployment plan. Do not switch traffic based on resource provisioning alone.

## Required before production cutover

1. Candidate startup/package mounting verified; /api/ping and /api/ready return JSON success. Retest before cutover.
2. Validate auth, tenant boundaries and critical business flows using isolated data and mocked outbound providers.
3. Both focused fixes implemented locally after user approval: quote staff operations require a verified
   application session and active tenant membership; public actions require a quote/tenant-bound token.
   Email and SMS publish a shared token before sending. External checkout no longer marks paid or sends receipts;
   unverified `paid` query parameters and unconfirmed direct-charge responses are rejected.
   Regression evidence: 61 API tests passed/1 skipped, 46 Angular tests passed, browser startup regression passed,
   production build/artifact checks passed, live isolated quote publish/reject/accept/decline passed after host restart.
   Not deployed to Azure yet. Old tokenless quote links must be resent. Verify supported staff login methods yield
   an application session before cutover; untrusted principal headers are deliberately not accepted by this endpoint.
   External-provider settlement/webhook reconciliation is not added by the handoff fix.
4. Configure production secrets securely and verify SWA-linked authentication/direct-backend restrictions.
5. Add production incident alerts; verify telemetry on real requests without sensitive data.
6. Update release workflow to separately deploy Functions and stop deploying managed SWA API only at cutover.
7. Preserve the old backend and tested artifact for rollback; verify post-cutover smoke and business flows.

The current hosting Bicep provisions a candidate with mock outbound modes. Do not blindly reapply it after
production configuration: app settings are declarative and require explicitly supplied secure runtime configuration.
Budget alerts are not a spending cap. A single B1 instance and S0 database do not guarantee zero downtime.

Detailed validation and deployment evidence: `.azure/deployment-plan.md`.
