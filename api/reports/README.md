# Reports API

`/api/reports` provides Power BI-ready reporting datasets computed from current Azure Table operational data.

## Routes

- `GET /api/reports` or `GET /api/reports/all`
- `GET /api/reports/powerbi`
- `GET /api/reports/overview`
- `GET /api/reports/funnel`
- `GET /api/reports/sales-trend`
- `GET /api/reports/invoice-aging`
- `GET /api/reports/lead-sources`
- `GET /api/reports/communications`
- `GET /api/reports/production-forecast`
- `GET /api/reports/cashflow-forecast`
- `GET /api/reports/powerbi-config`
- `GET /api/reports/powerbi-embed?includeToken=true`
- `POST /api/reports/seed-demo`

## Query params

- `from=YYYY-MM-DD` period start (default: first day of current month)
- `to=YYYY-MM-DD` period end (default: now)
- `monthsBack=12` monthly trend history range (1-36)
- `futureDays=90` future pipeline horizon (1-365)
- `forecastMonths=6` forecast horizon (1-24)
- `openingCash=0` optional opening cash input for first projected month

## Response shape

`/api/reports` and `/api/reports/powerbi` return:

```json
{
  "ok": true,
  "scope": "powerbi",
  "generatedAt": "2026-02-19T20:00:00.000Z",
  "filters": {
    "periodStart": "2026-02-01",
    "periodEnd": "2026-02-19",
    "monthsBack": 12,
    "futureDays": 90,
    "forecastMonths": 6
  },
  "tables": {
    "kpiSummary": [],
    "funnel": [],
    "salesTrend": [],
    "invoiceAging": [],
    "leadSources": [],
    "communicationVolume": [],
    "productionForecast": [],
    "cashflowForecast": []
  }
}
```

Scoped endpoints return `rows` for one table and include shared metadata.

## Power BI embed config

`/api/reports/powerbi-config` returns wiring status from app settings (safe response, no secrets).

Tenant resolution:

- request header: `x-tenant-id`
- or query param: `tenantId`
- or `DEFAULT_TENANT_ID` fallback

Power BI key lookup order:

1. `appsettings` row for the resolved tenant
2. `appsettings` row in partition `main` (shared default)
3. environment variables on the Function App

Supported keys:

- `POWERBI_TENANT_ID`
- `POWERBI_CLIENT_ID`
- `POWERBI_CLIENT_SECRET`
- `POWERBI_WORKSPACE_ID`
- `POWERBI_REPORT_ID`
- optional `POWERBI_REPORT_WEB_URL`

`/api/reports/powerbi-embed?includeToken=true` returns secure embed payload (`embedUrl`, `embedToken`, expiration) when all secure settings are configured.

## Demo data seeding

`POST /api/reports/seed-demo` upserts deterministic demo rows into `workitems` for report testing
without needing live production data.

## Power BI ingestion via API key (optional)

For Power BI Service connectors that cannot carry your app session cookie, you can enable
read-only report ingestion with an API key.

Set one env var:

- `REPORTS_INGEST_API_KEY` (or `REPORTS_PUBLIC_API_KEY`)

Then call report endpoints with:

- query param: `?apiKey=<your-key>`
- or header: `x-reports-api-key: <your-key>`

This bypass applies only to read scopes (`powerbi`, `overview`, `funnel`, etc.), not config or seed endpoints.

Example:

```bash
curl -X POST https://<your-app>/api/reports/seed-demo
```

## SQL rollout

Run `api/sql/reporting-schema.sql` in Azure SQL to create the reporting warehouse schema:

- dimensions/facts (`reporting.dim_*`, `reporting.fact_*`)
- aggregate tables (`reporting.agg_*`)
- Power BI views (`reporting.v_powerbi_*`)

The current API computes aggregates live from Azure Tables. Next ETL phase should populate `reporting.fact_*` and `reporting.agg_*` on a schedule.

## API Storage Backend

All report endpoints read via the API storage layer used by the app.

- `DATA_BACKEND=table` reads Azure Table Storage entities directly.
- `DATA_BACKEND=sql` reads entities from SQL-backed table `dbo.PathflowEntities`.

SQL mode env vars:

- `SQL_CONNECTION_STRING`
- or `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, `SQL_PASSWORD`
