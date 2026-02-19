const { TableClient } = require("@azure/data-tables");

const PARTITION = "main";
const TABLES = {
  lanes: "lanes",
  workItems: "workitems",
  events: "events",
  customers: "customers",
  emailMessages: "emailmessages",
  smsMessages: "smsmessages",
  purchaseOrders: "purchaseorders",
  schedule: "schedule"
};

const STAGE_ORDER = ["lead", "quote", "scheduled", "inprogress", "completed", "invoiced"];
const STAGE_LABELS = {
  lead: "Leads",
  quote: "Quotes",
  scheduled: "Scheduled",
  inprogress: "In Progress",
  completed: "Completed",
  invoiced: "Invoiced"
};

const DAY_MS = 24 * 60 * 60 * 1000;

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
}

function readScope(context, req) {
  const routeScope = asString(context && context.bindingData && context.bindingData.scope).toLowerCase();
  if (routeScope) return routeScope;
  return asString(req && req.query && req.query.scope).toLowerCase() || "all";
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function parseDate(value) {
  const raw = asString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed);
}

function isoDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function monthKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function inRange(date, from, to) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return false;
  return date.getTime() >= from.getTime() && date.getTime() <= to.getTime();
}

function laneStage(name) {
  const value = asString(name).toLowerCase();
  if (!value) return "other";
  if (/invoice|invoiced|paid/.test(value)) return "invoiced";
  if (/complete|pickup|done|ready/.test(value)) return "completed";
  if (/progress|in[- ]?progress|work in progress/.test(value)) return "inprogress";
  if (/sched|appointment|calendar/.test(value)) return "scheduled";
  if (/quote/.test(value)) return "quote";
  if (/lead/.test(value)) return "lead";
  return "other";
}

function normalizeSource(raw) {
  const value = asString(raw).toLowerCase();
  if (!value) return "";
  if (value.includes("email")) return "email";
  if (value.includes("sms") || value.includes("text")) return "sms";
  if (value.includes("web") || value.includes("widget") || value.includes("site")) return "web";
  if (value.includes("call") || value.includes("phone")) return "phone";
  if (value.includes("walk") || value.includes("store")) return "walk-in";
  if (value.includes("manual")) return "manual";
  return value;
}

function firstMoney(entity, keys) {
  for (const key of keys) {
    const value = asNumber(entity[key], NaN);
    if (Number.isFinite(value) && value >= 0) {
      return Number(value.toFixed(2));
    }
  }
  return 0;
}

function pct(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

async function getTableClient(tableName) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function listPartition(client) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) out.push(entity);
  return out;
}

function safeDate(entity) {
  const explicitCreated = parseDate(entity.createdAt);
  if (explicitCreated) return explicitCreated;
  const explicitUpdated = parseDate(entity.updatedAt);
  if (explicitUpdated) return explicitUpdated;
  const timestamp = parseDate(entity.timestamp);
  if (timestamp) return timestamp;
  return null;
}

function normalizeEvent(entity, laneById) {
  const type = asString(entity.type).toLowerCase();
  const eventAt = parseDate(entity.at) || safeDate(entity);
  const fromLaneId = asString(entity.fromLaneId);
  const toLaneId = asString(entity.toLaneId || entity.laneId);
  const fromLaneName = laneById.get(fromLaneId) || "";
  const toLaneName = laneById.get(toLaneId) || "";
  return {
    id: asString(entity.rowKey),
    workItemId: asString(entity.workItemId),
    type,
    eventAt,
    fromLaneId,
    toLaneId,
    fromStage: laneStage(fromLaneName),
    toStage: laneStage(toLaneName)
  };
}

function normalizePurchaseOrder(entity) {
  const subtotal = firstMoney(entity, ["subtotal", "total", "amount", "lineTotal"]);
  const status = asString(entity.status).toLowerCase() || "draft";
  const activityDate = parseDate(entity.receivedAt)
    || parseDate(entity.submittedAt)
    || parseDate(entity.updatedAt)
    || parseDate(entity.createdAt);
  return {
    id: asString(entity.rowKey),
    status,
    subtotal,
    activityDate
  };
}

function normalizeSchedule(entity) {
  return {
    id: asString(entity.rowKey),
    customerId: asString(entity.customerId),
    isBlocked: asBool(entity.isBlocked),
    start: parseDate(entity.start),
    end: parseDate(entity.end)
  };
}

function buildWindow(req) {
  const now = new Date();
  const defaultFrom = firstOfMonth(now);
  const defaultTo = now;

  const rawFrom = asString(req && req.query && req.query.from);
  const rawTo = asString(req && req.query && req.query.to);
  const parsedFrom = parseDate(rawFrom);
  const parsedTo = parseDate(rawTo);
  const from = parsedFrom ? startOfDay(parsedFrom) : defaultFrom;
  const to = parsedTo ? endOfDay(parsedTo) : defaultTo;
  const monthsBack = clamp(Math.floor(asNumber(req && req.query && req.query.monthsBack, 12)), 1, 36);
  const futureDays = clamp(Math.floor(asNumber(req && req.query && req.query.futureDays, 90)), 1, 365);
  const futureEnd = endOfDay(addDays(now, futureDays));

  return {
    now,
    from,
    to,
    monthsBack,
    futureDays,
    futureEnd
  };
}

function buildModel(raw) {
  const lanes = raw.lanes.map(entity => ({
    id: asString(entity.rowKey),
    name: asString(entity.name),
    stage: laneStage(entity.name)
  }));
  const laneById = new Map(lanes.map(item => [item.id, item.name]));

  const inboundEmailCustomers = new Set();
  for (const message of raw.emailMessages) {
    const customerId = asString(message.customerId);
    const direction = asString(message.direction).toLowerCase();
    if (direction === "inbound" && customerId) inboundEmailCustomers.add(customerId);
  }

  const inboundSmsCustomers = new Set();
  for (const message of raw.smsMessages) {
    const customerId = asString(message.customerId);
    const direction = asString(message.direction).toLowerCase();
    if (direction === "inbound" && customerId) inboundSmsCustomers.add(customerId);
  }

  const customers = raw.customers.map(entity => ({
    id: asString(entity.rowKey),
    name: asString(entity.name) || `${asString(entity.firstName)} ${asString(entity.lastName)}`.trim(),
    email: asString(entity.email),
    createdAt: parseDate(entity.createdAt) || safeDate(entity)
  }));
  const customerById = new Map(customers.map(item => [item.id, item]));

  const workItems = raw.workItems.map(entity => {
    const laneId = asString(entity.laneId);
    const laneName = laneById.get(laneId) || asString(entity.laneName);
    const stage = laneStage(laneName);
    const customerId = asString(entity.customerId);
    const customer = customerById.get(customerId) || null;

    let source = normalizeSource(
      entity.source
      || entity.leadSource
      || entity.channel
      || entity.origin
      || entity.intakeSource
    );
    if (!source) {
      if (customerId && inboundEmailCustomers.has(customerId)) source = "email";
      else if (customerId && inboundSmsCustomers.has(customerId)) source = "sms";
      else source = "manual";
    }

    const createdAt = parseDate(entity.createdAt) || safeDate(entity);
    const updatedAt = parseDate(entity.updatedAt) || createdAt;
    const closedAt = parseDate(entity.closedAt)
      || parseDate(entity.invoiceDate)
      || parseDate(entity.paidAt)
      || updatedAt
      || createdAt;
    const expectedDate = parseDate(entity.expectedDate)
      || parseDate(entity.scheduledFor)
      || parseDate(entity.startDate)
      || parseDate(entity.targetDate)
      || updatedAt
      || createdAt;

    const realizedAmount = firstMoney(entity, [
      "saleAmount",
      "invoiceAmount",
      "totalAmount",
      "revenue",
      "amount",
      "total",
      "value"
    ]);
    const quoteAmount = firstMoney(entity, [
      "quoteAmount",
      "quotedAmount",
      "estimateAmount",
      "estimatedAmount",
      "expectedAmount",
      "amount",
      "total",
      "value"
    ]);
    const expectedAmount = firstMoney(entity, [
      "expectedAmount",
      "estimateAmount",
      "quotedAmount",
      "quoteAmount",
      "amount",
      "total",
      "value"
    ]);

    const dueAt = parseDate(entity.invoiceDueAt)
      || parseDate(entity.dueAt)
      || parseDate(entity.paymentDueAt)
      || (closedAt ? addDays(closedAt, 30) : null);
    const paidAmount = firstMoney(entity, ["paidAmount", "amountPaid", "paymentAmount"]);
    const explicitBalance = firstMoney(entity, ["balanceDue", "outstandingAmount", "amountDue"]);
    const outstandingAmount = explicitBalance > 0
      ? explicitBalance
      : Math.max(0, Number((realizedAmount - paidAmount).toFixed(2)));

    return {
      id: asString(entity.rowKey),
      title: asString(entity.title),
      laneId,
      laneName,
      stage,
      customerId,
      customerName: asString(entity.customerName) || asString(customer && customer.name),
      source,
      createdAt,
      updatedAt,
      closedAt,
      expectedDate,
      dueAt,
      realizedAmount,
      quoteAmount,
      expectedAmount,
      paidAmount,
      outstandingAmount
    };
  });

  const events = raw.events.map(entity => normalizeEvent(entity, laneById));
  const purchaseOrders = raw.purchaseOrders.map(normalizePurchaseOrder);
  const schedules = raw.schedule.map(normalizeSchedule);

  const communications = [];
  for (const entity of raw.emailMessages) {
    communications.push({
      channel: "email",
      direction: asString(entity.direction).toLowerCase() === "inbound" ? "inbound" : "outbound",
      createdAt: parseDate(entity.createdAt) || safeDate(entity)
    });
  }
  for (const entity of raw.smsMessages) {
    communications.push({
      channel: "sms",
      direction: asString(entity.direction).toLowerCase() === "inbound" ? "inbound" : "outbound",
      createdAt: parseDate(entity.createdAt) || safeDate(entity)
    });
  }

  return {
    lanes,
    workItems,
    events,
    purchaseOrders,
    schedules,
    customers,
    communications
  };
}

function buildOverview(model, window) {
  const { from, to, now, futureEnd } = window;
  const inPeriodItems = model.workItems.filter(item => inRange(item.createdAt, from, to));
  const leadsPeriod = inPeriodItems.filter(item => item.stage === "lead");
  const quotesPeriod = inPeriodItems.filter(item => item.stage === "quote");
  const invoicesPeriod = model.workItems.filter(
    item => item.stage === "invoiced" && inRange(item.closedAt || item.updatedAt || item.createdAt, from, to)
  );

  let salesPastAmount = 0;
  let salesCurrentAmount = 0;
  for (const item of model.workItems) {
    if (item.stage !== "invoiced" && item.stage !== "completed") continue;
    const date = item.closedAt || item.updatedAt || item.createdAt;
    if (!date) continue;
    if (date.getTime() < from.getTime()) salesPastAmount += item.realizedAmount;
    else if (inRange(date, from, to)) salesCurrentAmount += item.realizedAmount;
  }

  let salesFutureAmount = 0;
  for (const item of model.workItems) {
    if (!["lead", "quote", "scheduled", "inprogress"].includes(item.stage)) continue;
    if (!item.expectedDate || !item.expectedAmount) continue;
    if (item.expectedDate.getTime() <= to.getTime() || item.expectedDate.getTime() > futureEnd.getTime()) continue;
    salesFutureAmount += item.expectedAmount;
  }

  const liveStageCounts = {
    lead: model.workItems.filter(item => item.stage === "lead").length,
    quote: model.workItems.filter(item => item.stage === "quote").length,
    scheduled: model.workItems.filter(item => item.stage === "scheduled").length,
    inprogress: model.workItems.filter(item => item.stage === "inprogress").length,
    completed: model.workItems.filter(item => item.stage === "completed").length,
    invoiced: model.workItems.filter(item => item.stage === "invoiced").length
  };

  const upcomingScheduled = model.schedules.filter(item =>
    !item.isBlocked
    && item.start
    && item.start.getTime() >= now.getTime()
    && item.start.getTime() <= futureEnd.getTime()
  ).length;

  const enteredLeadIds = new Set();
  const enteredQuoteIds = new Set();
  const convertedLeadToQuoteIds = new Set();
  const convertedQuoteToInvoiceIds = new Set();

  for (const event of model.events) {
    if (!event.workItemId || !inRange(event.eventAt, from, to)) continue;
    if (event.type === "created" && event.toStage === "lead") enteredLeadIds.add(event.workItemId);
    if (event.type === "created" && event.toStage === "quote") enteredQuoteIds.add(event.workItemId);
    if (event.type === "moved" && event.toStage === "lead") enteredLeadIds.add(event.workItemId);
    if (event.type === "moved" && event.toStage === "quote") enteredQuoteIds.add(event.workItemId);
    if (event.type === "moved" && event.toStage === "quote") convertedLeadToQuoteIds.add(event.workItemId);
    if (event.type === "moved" && (event.toStage === "invoiced" || event.toStage === "completed")) {
      convertedQuoteToInvoiceIds.add(event.workItemId);
    }
  }

  if (!enteredLeadIds.size) {
    for (const item of leadsPeriod) enteredLeadIds.add(item.id);
  }
  if (!enteredQuoteIds.size) {
    for (const item of quotesPeriod) enteredQuoteIds.add(item.id);
  }

  const invoiceAmountPeriod = invoicesPeriod.reduce((sum, item) => sum + item.realizedAmount, 0);
  const quoteAmountPeriod = quotesPeriod.reduce((sum, item) => sum + item.quoteAmount, 0);

  return [{
    report_generated_at: new Date().toISOString(),
    period_start: isoDate(from),
    period_end: isoDate(to),
    total_customers: model.customers.length,
    leads_created: leadsPeriod.length,
    quotes_created: quotesPeriod.length,
    invoices_created: invoicesPeriod.length,
    quote_amount: Number(quoteAmountPeriod.toFixed(2)),
    invoice_amount: Number(invoiceAmountPeriod.toFixed(2)),
    average_quote_amount: quotesPeriod.length ? Number((quoteAmountPeriod / quotesPeriod.length).toFixed(2)) : 0,
    average_invoice_amount: invoicesPeriod.length ? Number((invoiceAmountPeriod / invoicesPeriod.length).toFixed(2)) : 0,
    sales_past_amount: Number(salesPastAmount.toFixed(2)),
    sales_current_amount: Number(salesCurrentAmount.toFixed(2)),
    sales_future_amount: Number(salesFutureAmount.toFixed(2)),
    active_leads: liveStageCounts.lead,
    active_quotes: liveStageCounts.quote,
    active_scheduled: liveStageCounts.scheduled,
    active_in_progress: liveStageCounts.inprogress,
    active_completed: liveStageCounts.completed,
    active_invoiced: liveStageCounts.invoiced,
    upcoming_scheduled_jobs: upcomingScheduled,
    lead_to_quote_rate_pct: pct(convertedLeadToQuoteIds.size, enteredLeadIds.size) || 0,
    quote_to_invoice_rate_pct: pct(convertedQuoteToInvoiceIds.size, enteredQuoteIds.size) || 0
  }];
}

function buildFunnel(model) {
  const rows = [];
  let previousCount = null;
  for (let index = 0; index < STAGE_ORDER.length; index++) {
    const stage = STAGE_ORDER[index];
    const items = model.workItems.filter(item => item.stage === stage);
    const amount = items.reduce((sum, item) => {
      if (stage === "invoiced" || stage === "completed") return sum + item.realizedAmount;
      if (stage === "quote") return sum + item.quoteAmount;
      return sum + item.expectedAmount;
    }, 0);
    const count = items.length;
    rows.push({
      stage_order: index + 1,
      stage_key: stage,
      stage_label: STAGE_LABELS[stage] || stage,
      item_count: count,
      amount: Number(amount.toFixed(2)),
      conversion_from_previous_pct: previousCount == null ? null : (pct(count, previousCount) || 0)
    });
    previousCount = count;
  }
  return rows;
}

function buildSalesTrend(model, window) {
  const { to, monthsBack } = window;
  const startMonth = firstOfMonth(new Date(to.getFullYear(), to.getMonth() - (monthsBack - 1), 1));
  const monthRows = [];
  const monthMap = new Map();

  for (let i = 0; i < monthsBack; i++) {
    const cursor = new Date(startMonth.getFullYear(), startMonth.getMonth() + i, 1, 0, 0, 0, 0);
    const periodStart = firstOfMonth(cursor);
    const periodEnd = endOfDay(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0));
    const key = monthKey(periodStart);
    const row = {
      period_key: key,
      period_start: isoDate(periodStart),
      period_end: isoDate(periodEnd),
      leads_count: 0,
      quote_count: 0,
      quote_amount: 0,
      invoice_count: 0,
      sales_amount: 0,
      cogs_amount: 0,
      gross_profit: 0,
      gross_margin_pct: 0
    };
    monthRows.push(row);
    monthMap.set(key, row);
  }

  for (const item of model.workItems) {
    if (item.stage === "lead" && item.createdAt) {
      const key = monthKey(item.createdAt);
      const row = monthMap.get(key);
      if (row) row.leads_count += 1;
    }
    if (item.stage === "quote" && item.createdAt) {
      const key = monthKey(item.createdAt);
      const row = monthMap.get(key);
      if (row) {
        row.quote_count += 1;
        row.quote_amount += item.quoteAmount;
      }
    }
    if ((item.stage === "invoiced" || item.stage === "completed") && item.closedAt) {
      const key = monthKey(item.closedAt);
      const row = monthMap.get(key);
      if (row) {
        row.invoice_count += 1;
        row.sales_amount += item.realizedAmount;
      }
    }
  }

  for (const po of model.purchaseOrders) {
    if (!po.activityDate) continue;
    if (po.status !== "received" && po.status !== "ordered") continue;
    const key = monthKey(po.activityDate);
    const row = monthMap.get(key);
    if (row) row.cogs_amount += po.subtotal;
  }

  for (const row of monthRows) {
    row.quote_amount = Number(row.quote_amount.toFixed(2));
    row.sales_amount = Number(row.sales_amount.toFixed(2));
    row.cogs_amount = Number(row.cogs_amount.toFixed(2));
    row.gross_profit = Number((row.sales_amount - row.cogs_amount).toFixed(2));
    row.gross_margin_pct = row.sales_amount > 0
      ? Number(((row.gross_profit / row.sales_amount) * 100).toFixed(2))
      : 0;
  }

  return monthRows;
}

function buildInvoiceAging(model, window) {
  const now = window.now;
  const buckets = [
    { key: "current", label: "Current / 0-30", min: -99999, max: 30, count: 0, outstanding: 0 },
    { key: "31-60", label: "31-60 days", min: 31, max: 60, count: 0, outstanding: 0 },
    { key: "61-90", label: "61-90 days", min: 61, max: 90, count: 0, outstanding: 0 },
    { key: "90+", label: "90+ days", min: 91, max: 99999, count: 0, outstanding: 0 }
  ];

  for (const item of model.workItems) {
    if (item.stage !== "invoiced") continue;
    if (item.outstandingAmount <= 0) continue;
    const dueAt = item.dueAt || item.closedAt || item.updatedAt || item.createdAt;
    if (!dueAt) continue;
    const ageDays = Math.floor((startOfDay(now).getTime() - startOfDay(dueAt).getTime()) / DAY_MS);
    const bucket = buckets.find(row => ageDays >= row.min && ageDays <= row.max) || buckets[buckets.length - 1];
    bucket.count += 1;
    bucket.outstanding += item.outstandingAmount;
  }

  return buckets.map(row => ({
    bucket_key: row.key,
    bucket_label: row.label,
    min_days: row.min,
    max_days: row.max >= 99999 ? null : row.max,
    invoice_count: row.count,
    outstanding_amount: Number(row.outstanding.toFixed(2))
  }));
}

function buildLeadSources(model, window) {
  const bySource = new Map();
  for (const item of model.workItems) {
    if (item.stage !== "lead") continue;
    if (!inRange(item.createdAt, window.from, window.to)) continue;
    const key = item.source || "manual";
    const current = bySource.get(key) || { source_key: key, lead_count: 0, pipeline_amount: 0 };
    current.lead_count += 1;
    current.pipeline_amount += item.expectedAmount;
    bySource.set(key, current);
  }

  return Array.from(bySource.values())
    .map(row => ({
      source_key: row.source_key,
      lead_count: row.lead_count,
      pipeline_amount: Number(row.pipeline_amount.toFixed(2))
    }))
    .sort((a, b) => b.lead_count - a.lead_count || a.source_key.localeCompare(b.source_key));
}

function buildCommunicationVolume(model, window) {
  const byKey = new Map();
  for (const item of model.communications) {
    if (!inRange(item.createdAt, window.from, window.to)) continue;
    const key = `${item.channel}:${item.direction}`;
    const current = byKey.get(key) || {
      channel: item.channel,
      direction: item.direction,
      message_count: 0
    };
    current.message_count += 1;
    byKey.set(key, current);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.channel.localeCompare(b.channel) || a.direction.localeCompare(b.direction)
  );
}

function buildPayload(model, window) {
  const kpiSummary = buildOverview(model, window);
  const funnel = buildFunnel(model);
  const salesTrend = buildSalesTrend(model, window);
  const invoiceAging = buildInvoiceAging(model, window);
  const leadSources = buildLeadSources(model, window);
  const communicationVolume = buildCommunicationVolume(model, window);

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      periodStart: isoDate(window.from),
      periodEnd: isoDate(window.to),
      monthsBack: window.monthsBack,
      futureDays: window.futureDays
    },
    tables: {
      kpiSummary,
      funnel,
      salesTrend,
      invoiceAging,
      leadSources,
      communicationVolume
    }
  };
}

function responseByScope(scope, payload) {
  const normalized = asString(scope).toLowerCase();
  if (!normalized || normalized === "all" || normalized === "powerbi" || normalized === "export") {
    return payload;
  }
  if (normalized === "overview" || normalized === "summary" || normalized === "kpis") {
    return { ...payload, table: "kpiSummary", rows: payload.tables.kpiSummary };
  }
  if (normalized === "funnel") {
    return { ...payload, table: "funnel", rows: payload.tables.funnel };
  }
  if (normalized === "sales-trend" || normalized === "trend" || normalized === "trends") {
    return { ...payload, table: "salesTrend", rows: payload.tables.salesTrend };
  }
  if (normalized === "invoice-aging" || normalized === "aging") {
    return { ...payload, table: "invoiceAging", rows: payload.tables.invoiceAging };
  }
  if (normalized === "lead-sources" || normalized === "sources") {
    return { ...payload, table: "leadSources", rows: payload.tables.leadSources };
  }
  if (normalized === "communications" || normalized === "communication-volume") {
    return { ...payload, table: "communicationVolume", rows: payload.tables.communicationVolume };
  }
  return null;
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  if (method !== "GET") {
    context.res = json(405, { error: "Method not allowed" });
    return;
  }

  try {
    const scope = readScope(context, req);
    const window = buildWindow(req);

    const [
      lanesClient,
      workItemsClient,
      eventsClient,
      customersClient,
      emailClient,
      smsClient,
      purchaseOrdersClient,
      scheduleClient
    ] = await Promise.all([
      getTableClient(TABLES.lanes),
      getTableClient(TABLES.workItems),
      getTableClient(TABLES.events),
      getTableClient(TABLES.customers),
      getTableClient(TABLES.emailMessages),
      getTableClient(TABLES.smsMessages),
      getTableClient(TABLES.purchaseOrders),
      getTableClient(TABLES.schedule)
    ]);

    const [
      lanes,
      workItems,
      events,
      customers,
      emailMessages,
      smsMessages,
      purchaseOrders,
      schedule
    ] = await Promise.all([
      listPartition(lanesClient),
      listPartition(workItemsClient),
      listPartition(eventsClient),
      listPartition(customersClient),
      listPartition(emailClient),
      listPartition(smsClient),
      listPartition(purchaseOrdersClient),
      listPartition(scheduleClient)
    ]);

    const model = buildModel({
      lanes,
      workItems,
      events,
      customers,
      emailMessages,
      smsMessages,
      purchaseOrders,
      schedule
    });

    const payload = buildPayload(model, window);
    const scoped = responseByScope(scope, payload);
    if (!scoped) {
      context.res = json(400, {
        error: "Unknown report scope.",
        supportedScopes: [
          "all",
          "powerbi",
          "overview",
          "funnel",
          "sales-trend",
          "invoice-aging",
          "lead-sources",
          "communications"
        ]
      });
      return;
    }

    context.res = json(200, {
      ok: true,
      scope,
      ...scoped
    });
  } catch (err) {
    if (context.log && typeof context.log.error === "function") context.log.error(err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
