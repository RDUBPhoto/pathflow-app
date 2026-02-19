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

## Query params

- `from=YYYY-MM-DD` period start (default: first day of current month)
- `to=YYYY-MM-DD` period end (default: now)
- `monthsBack=12` monthly trend history range (1-36)
- `futureDays=90` future pipeline horizon (1-365)

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
    "futureDays": 90
  },
  "tables": {
    "kpiSummary": [],
    "funnel": [],
    "salesTrend": [],
    "invoiceAging": [],
    "leadSources": [],
    "communicationVolume": []
  }
}
```

Scoped endpoints return `rows` for one table and include shared metadata.

## SQL rollout

Run `api/sql/reporting-schema.sql` in Azure SQL to create the reporting warehouse schema:

- dimensions/facts (`reporting.dim_*`, `reporting.fact_*`)
- aggregate tables (`reporting.agg_*`)
- Power BI views (`reporting.v_powerbi_*`)

The current API computes aggregates live from Azure Tables. Next ETL phase should populate `reporting.fact_*` and `reporting.agg_*` on a schedule.
