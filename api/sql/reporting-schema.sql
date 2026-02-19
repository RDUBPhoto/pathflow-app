/*
  Pathflow Reporting Schema (Azure SQL)
  Phase 1: foundational dimensions/facts + Power BI aggregate tables/views.
*/

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'reporting')
BEGIN
  EXEC('CREATE SCHEMA reporting');
END
GO

IF OBJECT_ID('reporting.dim_date', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.dim_date (
    date_key            INT           NOT NULL PRIMARY KEY,        -- yyyymmdd
    [date]              DATE          NOT NULL UNIQUE,
    [year]              SMALLINT      NOT NULL,
    [quarter]           TINYINT       NOT NULL,
    [month]             TINYINT       NOT NULL,
    month_name          NVARCHAR(15)  NOT NULL,
    week_of_year        TINYINT       NOT NULL,
    day_of_month        TINYINT       NOT NULL,
    day_of_week         TINYINT       NOT NULL
  );
END
GO

IF OBJECT_ID('reporting.dim_customer', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.dim_customer (
    customer_key        BIGINT         IDENTITY(1,1) NOT NULL PRIMARY KEY,
    customer_id         NVARCHAR(64)   NOT NULL UNIQUE,            -- source rowKey
    full_name           NVARCHAR(200)  NULL,
    email               NVARCHAR(320)  NULL,
    phone               NVARCHAR(64)   NULL,
    created_at_utc      DATETIME2(0)   NULL,
    is_active           BIT            NOT NULL DEFAULT(1),
    source_updated_at   DATETIME2(0)   NULL,
    loaded_at_utc       DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID('reporting.dim_lane', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.dim_lane (
    lane_key            INT            IDENTITY(1,1) NOT NULL PRIMARY KEY,
    lane_id             NVARCHAR(64)   NOT NULL UNIQUE,            -- source rowKey
    lane_name           NVARCHAR(120)  NOT NULL,
    stage_key           NVARCHAR(32)   NOT NULL,                   -- lead|quote|scheduled|inprogress|completed|invoiced|other
    sort_order          INT            NOT NULL DEFAULT(0),
    source_updated_at   DATETIME2(0)   NULL,
    loaded_at_utc       DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID('reporting.fact_workitem_snapshot', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.fact_workitem_snapshot (
    workitem_id         NVARCHAR(64)   NOT NULL,                   -- source rowKey
    customer_key        BIGINT         NULL,
    lane_key            INT            NULL,
    stage_key           NVARCHAR(32)   NOT NULL,
    source_key          NVARCHAR(32)   NULL,                       -- email|sms|web|phone|walk-in|manual|other
    title               NVARCHAR(300)  NULL,
    created_at_utc      DATETIME2(0)   NULL,
    updated_at_utc      DATETIME2(0)   NULL,
    closed_at_utc       DATETIME2(0)   NULL,
    due_at_utc          DATETIME2(0)   NULL,
    quote_amount        DECIMAL(18,2)  NOT NULL DEFAULT(0),
    realized_amount     DECIMAL(18,2)  NOT NULL DEFAULT(0),
    expected_amount     DECIMAL(18,2)  NOT NULL DEFAULT(0),
    paid_amount         DECIMAL(18,2)  NOT NULL DEFAULT(0),
    outstanding_amount  DECIMAL(18,2)  NOT NULL DEFAULT(0),
    is_active           BIT            NOT NULL DEFAULT(1),
    snapshot_at_utc     DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_fact_workitem_snapshot PRIMARY KEY (workitem_id, snapshot_at_utc),
    CONSTRAINT FK_fact_workitem_customer FOREIGN KEY (customer_key) REFERENCES reporting.dim_customer(customer_key),
    CONSTRAINT FK_fact_workitem_lane FOREIGN KEY (lane_key) REFERENCES reporting.dim_lane(lane_key)
  );
END
GO

IF OBJECT_ID('reporting.fact_workitem_event', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.fact_workitem_event (
    event_id            NVARCHAR(64)   NOT NULL PRIMARY KEY,       -- source rowKey
    workitem_id         NVARCHAR(64)   NOT NULL,
    event_type          NVARCHAR(32)   NOT NULL,                   -- created|moved|deleted|other
    from_stage_key      NVARCHAR(32)   NULL,
    to_stage_key        NVARCHAR(32)   NULL,
    event_at_utc        DATETIME2(0)   NULL,
    loaded_at_utc       DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID('reporting.fact_schedule', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.fact_schedule (
    schedule_id         NVARCHAR(64)   NOT NULL PRIMARY KEY,
    customer_key        BIGINT         NULL,
    start_at_utc        DATETIME2(0)   NULL,
    end_at_utc          DATETIME2(0)   NULL,
    is_blocked          BIT            NOT NULL DEFAULT(0),
    created_at_utc      DATETIME2(0)   NULL,
    updated_at_utc      DATETIME2(0)   NULL,
    loaded_at_utc       DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_fact_schedule_customer FOREIGN KEY (customer_key) REFERENCES reporting.dim_customer(customer_key)
  );
END
GO

IF OBJECT_ID('reporting.fact_purchase_order', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.fact_purchase_order (
    purchase_order_id   NVARCHAR(64)   NOT NULL PRIMARY KEY,
    supplier            NVARCHAR(200)  NULL,
    status_key          NVARCHAR(32)   NOT NULL,                   -- draft|ordered|received|cancelled
    currency_code       NVARCHAR(8)    NOT NULL DEFAULT('USD'),
    subtotal_amount     DECIMAL(18,2)  NOT NULL DEFAULT(0),
    submitted_at_utc    DATETIME2(0)   NULL,
    received_at_utc     DATETIME2(0)   NULL,
    created_at_utc      DATETIME2(0)   NULL,
    updated_at_utc      DATETIME2(0)   NULL,
    loaded_at_utc       DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

/* Aggregate tables for BI */
IF OBJECT_ID('reporting.agg_kpi_summary_daily', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.agg_kpi_summary_daily (
    as_of_date                  DATE           NOT NULL PRIMARY KEY,
    period_start                DATE           NOT NULL,
    period_end                  DATE           NOT NULL,
    total_customers             INT            NOT NULL DEFAULT(0),
    leads_created               INT            NOT NULL DEFAULT(0),
    quotes_created              INT            NOT NULL DEFAULT(0),
    invoices_created            INT            NOT NULL DEFAULT(0),
    quote_amount                DECIMAL(18,2)  NOT NULL DEFAULT(0),
    invoice_amount              DECIMAL(18,2)  NOT NULL DEFAULT(0),
    average_quote_amount        DECIMAL(18,2)  NOT NULL DEFAULT(0),
    average_invoice_amount      DECIMAL(18,2)  NOT NULL DEFAULT(0),
    sales_past_amount           DECIMAL(18,2)  NOT NULL DEFAULT(0),
    sales_current_amount        DECIMAL(18,2)  NOT NULL DEFAULT(0),
    sales_future_amount         DECIMAL(18,2)  NOT NULL DEFAULT(0),
    active_leads                INT            NOT NULL DEFAULT(0),
    active_quotes               INT            NOT NULL DEFAULT(0),
    active_scheduled            INT            NOT NULL DEFAULT(0),
    active_in_progress          INT            NOT NULL DEFAULT(0),
    active_completed            INT            NOT NULL DEFAULT(0),
    active_invoiced             INT            NOT NULL DEFAULT(0),
    upcoming_scheduled_jobs     INT            NOT NULL DEFAULT(0),
    lead_to_quote_rate_pct      DECIMAL(9,2)   NOT NULL DEFAULT(0),
    quote_to_invoice_rate_pct   DECIMAL(9,2)   NOT NULL DEFAULT(0),
    loaded_at_utc               DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID('reporting.agg_funnel_daily', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.agg_funnel_daily (
    as_of_date                  DATE           NOT NULL,
    stage_key                   NVARCHAR(32)   NOT NULL,
    stage_order                 TINYINT        NOT NULL,
    stage_label                 NVARCHAR(64)   NOT NULL,
    item_count                  INT            NOT NULL DEFAULT(0),
    amount                      DECIMAL(18,2)  NOT NULL DEFAULT(0),
    conversion_from_previous_pct DECIMAL(9,2)  NULL,
    loaded_at_utc               DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_agg_funnel_daily PRIMARY KEY (as_of_date, stage_key)
  );
END
GO

IF OBJECT_ID('reporting.agg_sales_trend_monthly', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.agg_sales_trend_monthly (
    period_start                DATE           NOT NULL PRIMARY KEY,
    period_end                  DATE           NOT NULL,
    leads_count                 INT            NOT NULL DEFAULT(0),
    quote_count                 INT            NOT NULL DEFAULT(0),
    quote_amount                DECIMAL(18,2)  NOT NULL DEFAULT(0),
    invoice_count               INT            NOT NULL DEFAULT(0),
    sales_amount                DECIMAL(18,2)  NOT NULL DEFAULT(0),
    cogs_amount                 DECIMAL(18,2)  NOT NULL DEFAULT(0),
    gross_profit                DECIMAL(18,2)  NOT NULL DEFAULT(0),
    gross_margin_pct            DECIMAL(9,2)   NOT NULL DEFAULT(0),
    loaded_at_utc               DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID('reporting.agg_invoice_aging_daily', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.agg_invoice_aging_daily (
    as_of_date                  DATE           NOT NULL,
    bucket_key                  NVARCHAR(16)   NOT NULL,
    bucket_label                NVARCHAR(64)   NOT NULL,
    min_days                    INT            NOT NULL,
    max_days                    INT            NULL,
    invoice_count               INT            NOT NULL DEFAULT(0),
    outstanding_amount          DECIMAL(18,2)  NOT NULL DEFAULT(0),
    loaded_at_utc               DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_agg_invoice_aging_daily PRIMARY KEY (as_of_date, bucket_key)
  );
END
GO

IF OBJECT_ID('reporting.agg_lead_source_daily', 'U') IS NULL
BEGIN
  CREATE TABLE reporting.agg_lead_source_daily (
    as_of_date                  DATE           NOT NULL,
    source_key                  NVARCHAR(32)   NOT NULL,
    lead_count                  INT            NOT NULL DEFAULT(0),
    pipeline_amount             DECIMAL(18,2)  NOT NULL DEFAULT(0),
    loaded_at_utc               DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_agg_lead_source_daily PRIMARY KEY (as_of_date, source_key)
  );
END
GO

/* Useful indexing for warehouse refresh and BI query speed */
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'IX_fact_workitem_snapshot_stage_created'
  AND object_id = OBJECT_ID('reporting.fact_workitem_snapshot')
)
BEGIN
  CREATE INDEX IX_fact_workitem_snapshot_stage_created
    ON reporting.fact_workitem_snapshot (stage_key, created_at_utc)
    INCLUDE (quote_amount, realized_amount, expected_amount, outstanding_amount, customer_key, lane_key);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'IX_fact_workitem_event_event_at'
  AND object_id = OBJECT_ID('reporting.fact_workitem_event')
)
BEGIN
  CREATE INDEX IX_fact_workitem_event_event_at
    ON reporting.fact_workitem_event (event_at_utc, to_stage_key, from_stage_key);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'IX_fact_purchase_order_status_date'
  AND object_id = OBJECT_ID('reporting.fact_purchase_order')
)
BEGIN
  CREATE INDEX IX_fact_purchase_order_status_date
    ON reporting.fact_purchase_order (status_key, received_at_utc, submitted_at_utc)
    INCLUDE (subtotal_amount);
END
GO

/* Power BI consumption views */
CREATE OR ALTER VIEW reporting.v_powerbi_kpi_summary_latest
AS
SELECT TOP (1)
  as_of_date,
  period_start,
  period_end,
  total_customers,
  leads_created,
  quotes_created,
  invoices_created,
  quote_amount,
  invoice_amount,
  average_quote_amount,
  average_invoice_amount,
  sales_past_amount,
  sales_current_amount,
  sales_future_amount,
  active_leads,
  active_quotes,
  active_scheduled,
  active_in_progress,
  active_completed,
  active_invoiced,
  upcoming_scheduled_jobs,
  lead_to_quote_rate_pct,
  quote_to_invoice_rate_pct
FROM reporting.agg_kpi_summary_daily
ORDER BY as_of_date DESC;
GO

CREATE OR ALTER VIEW reporting.v_powerbi_funnel_latest
AS
SELECT f.*
FROM reporting.agg_funnel_daily f
INNER JOIN (
  SELECT MAX(as_of_date) AS as_of_date
  FROM reporting.agg_funnel_daily
) x ON x.as_of_date = f.as_of_date;
GO

CREATE OR ALTER VIEW reporting.v_powerbi_sales_trend
AS
SELECT
  period_start,
  period_end,
  leads_count,
  quote_count,
  quote_amount,
  invoice_count,
  sales_amount,
  cogs_amount,
  gross_profit,
  gross_margin_pct
FROM reporting.agg_sales_trend_monthly;
GO

CREATE OR ALTER VIEW reporting.v_powerbi_invoice_aging_latest
AS
SELECT a.*
FROM reporting.agg_invoice_aging_daily a
INNER JOIN (
  SELECT MAX(as_of_date) AS as_of_date
  FROM reporting.agg_invoice_aging_daily
) x ON x.as_of_date = a.as_of_date;
GO

CREATE OR ALTER VIEW reporting.v_powerbi_lead_sources_latest
AS
SELECT s.*
FROM reporting.agg_lead_source_daily s
INNER JOIN (
  SELECT MAX(as_of_date) AS as_of_date
  FROM reporting.agg_lead_source_daily
) x ON x.as_of_date = s.as_of_date;
GO
