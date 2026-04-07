const { TableClient } = require("../_shared/table-client");
const { resolveTenantId } = require("../_shared/tenant");
let requirePrincipal = async function defaultRequirePrincipal(context) {
  context.res = {
    status: 401,
    headers: { "content-type": "application/json" },
    body: { ok: false, error: "Not authenticated." }
  };
  return null;
};
try {
  const authShared = require("../_shared/auth");
  if (authShared && typeof authShared.requirePrincipal === "function") {
    requirePrincipal = authShared.requirePrincipal;
  }
} catch (_) {}

const SETTINGS_TABLE = "appsettings";
const TABLES = {
  lanes: "lanes",
  workItems: "workitems",
  events: "events",
  customers: "customers",
  emailMessages: "emailmessages",
  smsMessages: "smsmessages",
  purchaseOrders: "purchaseorders",
  schedule: "schedule",
  inventoryNeeds: "inventoryneeds",
  inventoryItems: "inventoryitems"
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

function constantTimeEqual(left, right) {
  const a = Buffer.from(asString(left));
  const b = Buffer.from(asString(right));
  if (!a.length || !b.length) return false;
  if (a.length !== b.length) return false;
  try {
    return require("crypto").timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function readHeader(req, key) {
  if (!req || !req.headers || typeof req.headers !== "object") return "";
  if (req.headers[key] != null) return asString(req.headers[key]);
  const normalized = asString(key).toLowerCase();
  for (const [name, value] of Object.entries(req.headers)) {
    if (asString(name).toLowerCase() !== normalized) continue;
    return asString(value);
  }
  return "";
}

function readIngestApiKey(req) {
  const query = (req && req.query) || {};
  const fromQuery = asString(query.apiKey || query.apikey || query.key || query.reportsKey);
  if (fromQuery) return fromQuery;
  const fromHeader = asString(
    readHeader(req, "x-reports-api-key") ||
    readHeader(req, "x-api-key")
  );
  if (fromHeader) return fromHeader;
  const authorization = asString(readHeader(req, "authorization"));
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  return asString((bearerMatch && bearerMatch[1]) || "");
}

function allowApiKeyRead(req, method, scope) {
  if (asString(method).toUpperCase() !== "GET") return false;
  const normalizedScope = asString(scope).toLowerCase();
  const allowedScopes = new Set([
    "",
    "all",
    "powerbi",
    "export",
    "overview",
    "summary",
    "kpis",
    "funnel",
    "sales-trend",
    "trend",
    "trends",
    "invoice-aging",
    "aging",
    "lead-sources",
    "sources",
    "communications",
    "communication-volume",
    "production-forecast",
    "productionforecast",
    "cashflow-forecast",
    "cashflowforecast"
  ]);
  if (!allowedScopes.has(normalizedScope)) return false;

  const expected = asString(process.env.REPORTS_INGEST_API_KEY || process.env.REPORTS_PUBLIC_API_KEY);
  if (!expected) return false;
  const supplied = readIngestApiKey(req);
  return constantTimeEqual(expected, supplied);
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function demoSeedingEnabled() {
  return asBool(process.env.REPORTS_DEMO_ENABLED);
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

  const queryScope = asString(req && req.query && req.query.scope).toLowerCase();
  if (queryScope) return queryScope;

  // Some runtime/proxy combinations can drop optional route binding data on POST requests.
  // Fallback to parsing the scope segment directly from the request URL path.
  const rawUrl = asString(req && (req.originalUrl || req.url));
  if (rawUrl) {
    try {
      const parsedUrl = new URL(rawUrl, "http://localhost");
      const queryScopeFromUrl = asString(parsedUrl.searchParams.get("scope")).toLowerCase();
      if (queryScopeFromUrl) return queryScopeFromUrl;

      const segments = parsedUrl.pathname.split("/").filter(Boolean);
      const reportsIndex = segments.findIndex((segment) => segment.toLowerCase() === "reports");
      if (reportsIndex >= 0 && segments.length > reportsIndex + 1) {
        return asString(decodeURIComponent(segments[reportsIndex + 1])).toLowerCase();
      }
    } catch (_) {}
  }

  return "all";
}

function powerBiConfigFromEnv() {
  return {
    tenantId: asString(process.env.POWERBI_TENANT_ID),
    clientId: asString(process.env.POWERBI_CLIENT_ID),
    clientSecret: asString(process.env.POWERBI_CLIENT_SECRET),
    workspaceId: asString(process.env.POWERBI_WORKSPACE_ID),
    reportId: asString(process.env.POWERBI_REPORT_ID),
    reportWebUrl: asString(process.env.POWERBI_REPORT_WEB_URL)
  };
}

function parseSettingValue(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asPowerBiSettingValue(raw) {
  const parsed = parseSettingValue(raw);
  return asString(parsed);
}

async function getSettingTableClient() {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, SETTINGS_TABLE);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function readPowerBiConfigFromSettings(tenantId) {
  const keys = [
    "POWERBI_TENANT_ID",
    "POWERBI_CLIENT_ID",
    "POWERBI_CLIENT_SECRET",
    "POWERBI_WORKSPACE_ID",
    "POWERBI_REPORT_ID",
    "POWERBI_REPORT_WEB_URL"
  ];

  const client = await getSettingTableClient();

  async function readKey(partitionKey, rowKey) {
    try {
      const entity = await client.getEntity(partitionKey, rowKey);
      return asPowerBiSettingValue(entity.valueJson);
    } catch {
      return "";
    }
  }

  const output = {};
  for (const key of keys) {
    const value = await readKey(tenantId, key);
    output[key] = value;
  }

  return {
    tenantId: output.POWERBI_TENANT_ID,
    clientId: output.POWERBI_CLIENT_ID,
    clientSecret: output.POWERBI_CLIENT_SECRET,
    workspaceId: output.POWERBI_WORKSPACE_ID,
    reportId: output.POWERBI_REPORT_ID,
    reportWebUrl: output.POWERBI_REPORT_WEB_URL
  };
}

async function getPowerBiConfig(req) {
  const tenantId = resolveTenantId(req, null);
  let settingConfig = null;
  try {
    settingConfig = await readPowerBiConfigFromSettings(tenantId);
  } catch (_) {}

  const envConfig = powerBiConfigFromEnv();
  const resolved = {
    tenantId: asString((settingConfig && settingConfig.tenantId) || envConfig.tenantId),
    clientId: asString((settingConfig && settingConfig.clientId) || envConfig.clientId),
    clientSecret: asString((settingConfig && settingConfig.clientSecret) || envConfig.clientSecret),
    workspaceId: asString((settingConfig && settingConfig.workspaceId) || envConfig.workspaceId),
    reportId: asString((settingConfig && settingConfig.reportId) || envConfig.reportId),
    reportWebUrl: asString((settingConfig && settingConfig.reportWebUrl) || envConfig.reportWebUrl)
  };

  return {
    tenantId,
    config: resolved
  };
}

function powerBiStatus(config) {
  const missingSecureKeys = [];
  if (!config.tenantId) missingSecureKeys.push("POWERBI_TENANT_ID");
  if (!config.clientId) missingSecureKeys.push("POWERBI_CLIENT_ID");
  if (!config.clientSecret) missingSecureKeys.push("POWERBI_CLIENT_SECRET");
  if (!config.workspaceId) missingSecureKeys.push("POWERBI_WORKSPACE_ID");
  if (!config.reportId) missingSecureKeys.push("POWERBI_REPORT_ID");

  const secureEmbedReady = missingSecureKeys.length === 0;
  const webEmbedReady = !!config.reportWebUrl;

  return {
    secureEmbedReady,
    webEmbedReady,
    configured: secureEmbedReady || webEmbedReady,
    missingSecureKeys,
    reportWebUrl: config.reportWebUrl || null
  };
}

async function powerBiServiceToken(config) {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://analysis.windows.net/powerbi/api/.default"
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AAD token request failed (${response.status}): ${detail || "Unknown response"}`);
  }
  const jsonBody = await response.json();
  const token = asString(jsonBody.access_token);
  if (!token) throw new Error("AAD token response did not include access_token.");
  return token;
}

async function powerBiReportMetadata(config, accessToken) {
  const endpoint = `https://api.powerbi.com/v1.0/myorg/groups/${encodeURIComponent(config.workspaceId)}/reports/${encodeURIComponent(config.reportId)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Power BI report lookup failed (${response.status}): ${detail || "Unknown response"}`);
  }
  const jsonBody = await response.json();
  return {
    id: asString(jsonBody.id),
    name: asString(jsonBody.name),
    embedUrl: asString(jsonBody.embedUrl)
  };
}

async function powerBiEmbedToken(config, accessToken) {
  const endpoint = `https://api.powerbi.com/v1.0/myorg/groups/${encodeURIComponent(config.workspaceId)}/reports/${encodeURIComponent(config.reportId)}/GenerateToken`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ accessLevel: "View" })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Power BI embed token request failed (${response.status}): ${detail || "Unknown response"}`);
  }
  const jsonBody = await response.json();
  return {
    token: asString(jsonBody.token),
    tokenId: asString(jsonBody.tokenId),
    expiration: asString(jsonBody.expiration)
  };
}

async function buildPowerBiEmbedConfig(config) {
  const status = powerBiStatus(config);
  if (!status.secureEmbedReady) {
    return {
      ...status,
      mode: status.webEmbedReady ? "web" : "unconfigured"
    };
  }

  const accessToken = await powerBiServiceToken(config);
  const report = await powerBiReportMetadata(config, accessToken);
  const embed = await powerBiEmbedToken(config, accessToken);

  return {
    ...status,
    mode: "secure-embed",
    reportId: report.id || config.reportId,
    reportName: report.name || null,
    embedUrl: report.embedUrl || null,
    embedToken: embed.token || null,
    embedTokenId: embed.tokenId || null,
    embedTokenExpiration: embed.expiration || null,
    workspaceId: config.workspaceId
  };
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

async function listPartition(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(entity);
  return out;
}

function isoDateTime(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  return date.toISOString();
}

function seedAt(now, dayOffset, hour = 9, minute = 0) {
  const shifted = addDays(now, dayOffset);
  return new Date(
    shifted.getFullYear(),
    shifted.getMonth(),
    shifted.getDate(),
    hour,
    minute,
    0,
    0
  );
}

async function upsertPartitionEntities(client, tenantId, rows) {
  for (const row of rows) {
    await client.upsertEntity({ partitionKey: tenantId, ...row }, "Merge");
  }
}

async function seedDemoReportData(tenantId) {
  const workItemsClient = await getTableClient(TABLES.workItems);
  const now = new Date();
  const stamped = isoDateTime(now);

  const stageLabel = {
    lead: "Leads",
    quote: "Quotes",
    scheduled: "Scheduled",
    inprogress: "In Progress",
    completed: "Completed",
    invoiced: "Invoiced"
  };

  const rows = [
    {
      rowKey: "seed-report-item-01",
      title: "Avery Chen - Brake Inspection",
      customerName: "Avery Chen",
      source: "web",
      laneId: "seed-report-lane-lead",
      laneName: stageLabel.lead,
      createdAt: isoDateTime(seedAt(now, -6, 10)),
      updatedAt: stamped,
      expectedDate: isoDateTime(seedAt(now, 10, 9)),
      expectedAmount: 980,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-02",
      title: "Jordan Miles - Lift Kit Quote",
      customerName: "Jordan Miles",
      source: "email",
      laneId: "seed-report-lane-quote",
      laneName: stageLabel.quote,
      createdAt: isoDateTime(seedAt(now, -7, 11)),
      updatedAt: stamped,
      expectedDate: isoDateTime(seedAt(now, 6, 9)),
      quoteAmount: 1840,
      expectedAmount: 1840,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-03",
      title: "Morgan Lee - Transmission Service",
      customerName: "Morgan Lee",
      source: "phone",
      laneId: "seed-report-lane-scheduled",
      laneName: stageLabel.scheduled,
      createdAt: isoDateTime(seedAt(now, -9, 9)),
      updatedAt: stamped,
      expectedDate: isoDateTime(seedAt(now, 2, 13)),
      quoteAmount: 2300,
      expectedAmount: 2300,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-04",
      title: "Sam Patel - Differential Rebuild",
      customerName: "Sam Patel",
      source: "walk-in",
      laneId: "seed-report-lane-inprogress",
      laneName: stageLabel.inprogress,
      createdAt: isoDateTime(seedAt(now, -4, 8)),
      updatedAt: stamped,
      expectedDate: isoDateTime(seedAt(now, 1, 10)),
      expectedAmount: 1650,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-05",
      title: "Riley Jones - Alignment + Tires",
      customerName: "Riley Jones",
      source: "sms",
      laneId: "seed-report-lane-completed",
      laneName: stageLabel.completed,
      createdAt: isoDateTime(seedAt(now, -12, 8)),
      updatedAt: stamped,
      closedAt: isoDateTime(seedAt(now, -1, 16)),
      realizedAmount: 1420,
      expectedAmount: 1420,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-06",
      title: "Robert Wojtow - F-250 Repair",
      customerName: "Robert Wojtow",
      source: "manual",
      laneId: "seed-report-lane-invoiced",
      laneName: stageLabel.invoiced,
      createdAt: isoDateTime(seedAt(now, -20, 8)),
      updatedAt: stamped,
      closedAt: isoDateTime(seedAt(now, -6, 15)),
      dueAt: isoDateTime(seedAt(now, 10, 23)),
      realizedAmount: 1324.9,
      paidAmount: 0,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-07",
      title: "Casey Nguyen - Suspension Refresh",
      customerName: "Casey Nguyen",
      source: "web",
      laneId: "seed-report-lane-invoiced",
      laneName: stageLabel.invoiced,
      createdAt: isoDateTime(seedAt(now, -35, 9)),
      updatedAt: stamped,
      closedAt: isoDateTime(seedAt(now, -30, 14)),
      dueAt: isoDateTime(seedAt(now, -5, 23)),
      realizedAmount: 980,
      paidAmount: 150,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-08",
      title: "John Smith - Driveline Service",
      customerName: "John Smith",
      source: "email",
      laneId: "seed-report-lane-invoiced",
      laneName: stageLabel.invoiced,
      createdAt: isoDateTime(seedAt(now, -60, 10)),
      updatedAt: stamped,
      closedAt: isoDateTime(seedAt(now, -58, 14)),
      dueAt: isoDateTime(seedAt(now, -20, 23)),
      realizedAmount: 2100,
      paidAmount: 2100,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-09",
      title: "Avery Chen - Invoice Follow-up",
      customerName: "Avery Chen",
      source: "phone",
      laneId: "seed-report-lane-invoiced",
      laneName: stageLabel.invoiced,
      createdAt: isoDateTime(seedAt(now, -75, 11)),
      updatedAt: stamped,
      closedAt: isoDateTime(seedAt(now, -70, 15)),
      dueAt: isoDateTime(seedAt(now, -35, 23)),
      realizedAmount: 760,
      paidAmount: 100,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-10",
      title: "Morgan Lee - Fleet Service Follow-up",
      customerName: "Morgan Lee",
      source: "web",
      laneId: "seed-report-lane-quote",
      laneName: stageLabel.quote,
      createdAt: isoDateTime(seedAt(now, -1, 13)),
      updatedAt: stamped,
      expectedDate: isoDateTime(seedAt(now, 42, 10)),
      quoteAmount: 3200,
      expectedAmount: 3200,
      isReportSeed: true
    },
    {
      rowKey: "seed-report-item-11",
      title: "Jordan Miles - Future Build Slot",
      customerName: "Jordan Miles",
      source: "manual",
      laneId: "seed-report-lane-scheduled",
      laneName: stageLabel.scheduled,
      createdAt: isoDateTime(seedAt(now, -2, 10)),
      updatedAt: stamped,
      expectedDate: isoDateTime(seedAt(now, 35, 9)),
      expectedAmount: 2750,
      isReportSeed: true
    }
  ];

  await upsertPartitionEntities(workItemsClient, tenantId, rows);

  const invoicesSeeded = rows.filter(item => item.laneName === stageLabel.invoiced).length;
  return {
    workItemsSeeded: rows.length,
    invoicesSeeded
  };
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

function normalizeInventoryNeed(entity) {
  return {
    id: asString(entity.rowKey),
    customerId: asString(entity.customerId),
    scheduleStart: parseDate(entity.scheduleStart),
    qty: Math.max(1, Math.floor(asNumber(entity.qty, 1))),
    sku: asString(entity.sku),
    status: asString(entity.status).toLowerCase() || "needs-order",
    createdAt: parseDate(entity.createdAt) || safeDate(entity),
    updatedAt: parseDate(entity.updatedAt) || safeDate(entity)
  };
}

function normalizeInventoryItem(entity) {
  return {
    id: asString(entity.rowKey),
    sku: asString(entity.sku),
    unitCost: Math.max(0, asNumber(entity.unitCost, 0))
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
  const forecastMonths = clamp(Math.floor(asNumber(req && req.query && req.query.forecastMonths, 6)), 1, 24);
  const openingCash = Number(asNumber(req && req.query && req.query.openingCash, 0).toFixed(2));
  const futureEnd = endOfDay(addDays(now, futureDays));

  return {
    now,
    from,
    to,
    monthsBack,
    futureDays,
    forecastMonths,
    openingCash,
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
  const inventoryNeeds = raw.inventoryNeeds.map(normalizeInventoryNeed);
  const inventoryItems = raw.inventoryItems.map(normalizeInventoryItem);

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
    inventoryNeeds,
    inventoryItems,
    customers,
    communications
  };
}

function monthRowsFromWindow(window) {
  const months = [];
  const monthsMap = new Map();
  const base = firstOfMonth(window.now);
  for (let i = 0; i < window.forecastMonths; i++) {
    const start = new Date(base.getFullYear(), base.getMonth() + i, 1, 0, 0, 0, 0);
    const end = endOfDay(new Date(start.getFullYear(), start.getMonth() + 1, 0));
    const key = monthKey(start);
    const row = {
      period_key: key,
      period_start: isoDate(start),
      period_end: isoDate(end)
    };
    months.push(row);
    monthsMap.set(key, row);
  }
  return { months, monthsMap };
}

function estimateHistoricalMetrics(model, window) {
  const historyStart = addDays(window.now, -180);
  let realizedSales = 0;
  let realizedCount = 0;
  let poSpend = 0;
  let poCount = 0;
  let quoteCount = 0;
  let quoteConverted = 0;

  for (const item of model.workItems) {
    const closedAt = item.closedAt || item.updatedAt || item.createdAt;
    if ((item.stage === "invoiced" || item.stage === "completed") && closedAt && closedAt >= historyStart) {
      if (item.realizedAmount > 0) {
        realizedSales += item.realizedAmount;
        realizedCount += 1;
      }
    }
  }

  for (const event of model.events) {
    if (!event.workItemId || !event.eventAt || event.eventAt < historyStart) continue;
    if (event.type === "moved" && event.toStage === "quote") quoteCount += 1;
    if (event.type === "moved" && (event.toStage === "invoiced" || event.toStage === "completed")) {
      quoteConverted += 1;
    }
  }

  for (const po of model.purchaseOrders) {
    if (!po.activityDate || po.activityDate < historyStart) continue;
    if (po.status === "received" || po.status === "ordered") {
      poSpend += po.subtotal;
      poCount += 1;
    }
  }

  const avgInvoiceAmount = realizedCount > 0 ? Number((realizedSales / realizedCount).toFixed(2)) : 650;
  const cogsRatio = realizedSales > 0
    ? clamp(Number((poSpend / realizedSales).toFixed(4)), 0.1, 0.85)
    : 0.4;
  const quoteWinRate = quoteCount > 0
    ? clamp(Number((quoteConverted / quoteCount).toFixed(4)), 0.2, 0.95)
    : 0.62;
  const avgPoSpend = poCount > 0 ? Number((poSpend / poCount).toFixed(2)) : avgInvoiceAmount * cogsRatio;

  return {
    avgInvoiceAmount,
    cogsRatio,
    quoteWinRate,
    avgPoSpend
  };
}

function estimateNeedCost(need, inventoryBySku, fallbackUnitCost) {
  const sku = asString(need.sku).toLowerCase();
  const item = sku ? inventoryBySku.get(sku) : null;
  const unitCost = item ? item.unitCost : fallbackUnitCost;
  return Number((Math.max(1, need.qty) * Math.max(0, unitCost || 0)).toFixed(2));
}

function buildProductionForecast(model, window) {
  const { months, monthsMap } = monthRowsFromWindow(window);
  const metrics = estimateHistoricalMetrics(model, window);
  const inventoryBySku = new Map(
    model.inventoryItems
      .filter(item => item.sku)
      .map(item => [item.sku.toLowerCase(), item])
  );

  const scheduledCustomerMonths = new Set();
  const customerOpenAmount = new Map();
  for (const item of model.workItems) {
    if (!item.customerId) continue;
    if (!["lead", "quote", "scheduled", "inprogress"].includes(item.stage)) continue;
    const baseAmount = item.expectedAmount || item.quoteAmount || 0;
    if (baseAmount <= 0) continue;
    const current = customerOpenAmount.get(item.customerId) || 0;
    customerOpenAmount.set(item.customerId, Math.max(current, baseAmount));
  }

  for (const schedule of model.schedules) {
    if (schedule.isBlocked || !schedule.start) continue;
    const key = monthKey(schedule.start);
    const month = monthsMap.get(key);
    if (!month) continue;
    const customerKey = schedule.customerId ? `${schedule.customerId}:${key}` : "";
    if (customerKey) scheduledCustomerMonths.add(customerKey);
    month.scheduled_jobs = (month.scheduled_jobs || 0) + 1;
    const customerEstimate = schedule.customerId ? (customerOpenAmount.get(schedule.customerId) || 0) : 0;
    const estimate = customerEstimate > 0 ? customerEstimate : metrics.avgInvoiceAmount;
    month.scheduled_revenue = Number(((month.scheduled_revenue || 0) + estimate).toFixed(2));
  }

  const stageWeights = {
    lead: 0.22,
    quote: metrics.quoteWinRate,
    scheduled: 0.85,
    inprogress: 0.95
  };

  for (const item of model.workItems) {
    if (!["lead", "quote", "scheduled", "inprogress"].includes(item.stage)) continue;
    const target = item.expectedDate || item.updatedAt || item.createdAt;
    if (!target) continue;
    const key = monthKey(target);
    const month = monthsMap.get(key);
    if (!month) continue;
    if (item.stage === "scheduled" && item.customerId && scheduledCustomerMonths.has(`${item.customerId}:${key}`)) {
      continue;
    }
    const baseAmount = item.expectedAmount || item.quoteAmount || metrics.avgInvoiceAmount;
    const weighted = baseAmount * (stageWeights[item.stage] || 0.5);
    month.pipeline_weighted_revenue = Number(((month.pipeline_weighted_revenue || 0) + weighted).toFixed(2));
    month.pipeline_items = (month.pipeline_items || 0) + 1;
  }

  for (const po of model.purchaseOrders) {
    const poDate = po.activityDate;
    if (!poDate) continue;
    const key = monthKey(poDate);
    const month = monthsMap.get(key);
    if (!month) continue;
    if (po.status === "draft" || po.status === "ordered") {
      month.committed_po_spend = Number(((month.committed_po_spend || 0) + po.subtotal).toFixed(2));
    }
  }

  for (const need of model.inventoryNeeds) {
    if (need.status !== "needs-order" && need.status !== "po-draft") continue;
    const needDate = need.scheduleStart || need.updatedAt || need.createdAt;
    if (!needDate) continue;
    const key = monthKey(needDate);
    const month = monthsMap.get(key);
    if (!month) continue;
    const needCost = estimateNeedCost(need, inventoryBySku, metrics.avgPoSpend / 4 || 60);
    month.pending_need_spend = Number(((month.pending_need_spend || 0) + needCost).toFixed(2));
  }

  return months.map(month => {
    const scheduledRevenue = Number((month.scheduled_revenue || 0).toFixed(2));
    const weightedRevenue = Number((month.pipeline_weighted_revenue || 0).toFixed(2));
    const projectedRevenue = Number((scheduledRevenue + weightedRevenue).toFixed(2));
    const baseCogs = Number((projectedRevenue * metrics.cogsRatio).toFixed(2));
    const committedSpend = Number(((month.committed_po_spend || 0) + (month.pending_need_spend || 0)).toFixed(2));
    const projectedPartsCogs = Math.max(baseCogs, committedSpend);
    const projectedLaborCost = Number((projectedRevenue * 0.18).toFixed(2));
    const projectedGrossProfit = Number((projectedRevenue - projectedPartsCogs - projectedLaborCost).toFixed(2));
    const projectedGrossMarginPct = projectedRevenue > 0
      ? Number(((projectedGrossProfit / projectedRevenue) * 100).toFixed(2))
      : 0;

    return {
      period_key: month.period_key,
      period_start: month.period_start,
      period_end: month.period_end,
      scheduled_jobs: month.scheduled_jobs || 0,
      pipeline_items: month.pipeline_items || 0,
      scheduled_revenue: scheduledRevenue,
      pipeline_weighted_revenue: weightedRevenue,
      projected_revenue: projectedRevenue,
      committed_po_spend: Number((month.committed_po_spend || 0).toFixed(2)),
      pending_need_spend: Number((month.pending_need_spend || 0).toFixed(2)),
      projected_parts_cogs: Number(projectedPartsCogs.toFixed(2)),
      projected_labor_cost: projectedLaborCost,
      projected_gross_profit: projectedGrossProfit,
      projected_gross_margin_pct: projectedGrossMarginPct
    };
  });
}

function buildCashflowForecast(model, window, productionForecast) {
  const monthMap = new Map(productionForecast.map(row => [row.period_key, row]));
  const out = [];
  let openingCash = Number((window.openingCash || 0).toFixed(2));

  for (const month of productionForecast) {
    let invoiceCollectionsDue = 0;
    for (const item of model.workItems) {
      if (item.stage !== "invoiced" || item.outstandingAmount <= 0) continue;
      const dueDate = item.dueAt || item.closedAt || item.updatedAt || item.createdAt;
      if (!dueDate || monthKey(dueDate) !== month.period_key) continue;
      invoiceCollectionsDue += item.outstandingAmount;
    }

    const forecastCollections = Number((month.projected_revenue * 0.62).toFixed(2));
    const projectedInflow = Number((invoiceCollectionsDue + forecastCollections).toFixed(2));
    const projectedOutflow = Number((
      month.projected_parts_cogs
      + month.projected_labor_cost
      + (month.committed_po_spend * 0.15)
    ).toFixed(2));
    const netCashflow = Number((projectedInflow - projectedOutflow).toFixed(2));
    const endingCash = Number((openingCash + netCashflow).toFixed(2));

    out.push({
      period_key: month.period_key,
      period_start: month.period_start,
      period_end: month.period_end,
      opening_cash: openingCash,
      invoice_collections_due: Number(invoiceCollectionsDue.toFixed(2)),
      forecast_collections: forecastCollections,
      projected_inflow: projectedInflow,
      projected_outflow: projectedOutflow,
      net_cashflow: netCashflow,
      ending_cash: endingCash
    });
    openingCash = endingCash;
  }

  return out;
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
  const productionForecast = buildProductionForecast(model, window);
  const cashflowForecast = buildCashflowForecast(model, window, productionForecast);

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      periodStart: isoDate(window.from),
      periodEnd: isoDate(window.to),
      monthsBack: window.monthsBack,
      futureDays: window.futureDays,
      forecastMonths: window.forecastMonths,
      openingCash: window.openingCash
    },
    tables: {
      kpiSummary,
      funnel,
      salesTrend,
      invoiceAging,
      leadSources,
      communicationVolume,
      productionForecast,
      cashflowForecast
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
  if (normalized === "production-forecast" || normalized === "productionforecast") {
    return { ...payload, table: "productionForecast", rows: payload.tables.productionForecast };
  }
  if (normalized === "cashflow-forecast" || normalized === "cashflowforecast") {
    return { ...payload, table: "cashflowForecast", rows: payload.tables.cashflowForecast };
  }
  return null;
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const scope = readScope(context, req);
  const tenantId = resolveTenantId(req, req && typeof req.body === "object" ? req.body : null);
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  const allowReadWithApiKey = allowApiKeyRead(req, method, scope);
  if (!allowReadWithApiKey) {
    const principal = await requirePrincipal(context, req);
    if (!principal) return;
  }

  try {
    if (method === "POST") {
      if (scope !== "seed-demo") {
        context.res = json(405, { error: "Method not allowed" });
        return;
      }
      if (!demoSeedingEnabled()) {
        context.res = json(403, { error: "Demo seeding is disabled." });
        return;
      }

      const seedSummary = await seedDemoReportData(tenantId);
      context.res = json(200, {
        ok: true,
        scope,
        message: "Demo reporting data seeded.",
        ...seedSummary
      });
      return;
    }

    if (method !== "GET") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    if (scope === "powerbi-embed" || scope === "powerbi-config") {
      const includeToken = asBool(req && req.query && req.query.includeToken);
      const powerBiState = await getPowerBiConfig(req);
      const status = powerBiStatus(powerBiState.config);
      if (!includeToken || !status.secureEmbedReady) {
        context.res = json(200, {
          ok: true,
          scope,
          powerBi: {
            ...status,
            tenantId: powerBiState.tenantId,
            mode: status.secureEmbedReady ? "secure-embed" : (status.webEmbedReady ? "web" : "unconfigured")
          }
        });
        return;
      }

      let embedConfig;
      try {
        embedConfig = await buildPowerBiEmbedConfig(powerBiState.config);
      } catch (err) {
        context.res = json(200, {
          ok: true,
          scope,
          powerBi: {
            ...status,
            tenantId: powerBiState.tenantId,
            mode: status.webEmbedReady ? "web" : "unconfigured",
            error: String((err && err.message) || err || "Power BI embed configuration failed.")
          }
        });
        return;
      }
      context.res = json(200, {
        ok: true,
        scope,
        powerBi: {
          ...embedConfig,
          tenantId: powerBiState.tenantId
        }
      });
      return;
    }

    const window = buildWindow(req);

    const [
      lanesClient,
      workItemsClient,
      eventsClient,
      customersClient,
      emailClient,
      smsClient,
      purchaseOrdersClient,
      scheduleClient,
      inventoryNeedsClient,
      inventoryItemsClient
    ] = await Promise.all([
      getTableClient(TABLES.lanes),
      getTableClient(TABLES.workItems),
      getTableClient(TABLES.events),
      getTableClient(TABLES.customers),
      getTableClient(TABLES.emailMessages),
      getTableClient(TABLES.smsMessages),
      getTableClient(TABLES.purchaseOrders),
      getTableClient(TABLES.schedule),
      getTableClient(TABLES.inventoryNeeds),
      getTableClient(TABLES.inventoryItems)
    ]);

    const [
      lanes,
      workItems,
      events,
      customers,
      emailMessages,
      smsMessages,
      purchaseOrders,
      schedule,
      inventoryNeeds,
      inventoryItems
    ] = await Promise.all([
      listPartition(lanesClient, tenantId),
      listPartition(workItemsClient, tenantId),
      listPartition(eventsClient, tenantId),
      listPartition(customersClient, tenantId),
      listPartition(emailClient, tenantId),
      listPartition(smsClient, tenantId),
      listPartition(purchaseOrdersClient, tenantId),
      listPartition(scheduleClient, tenantId),
      listPartition(inventoryNeedsClient, tenantId),
      listPartition(inventoryItemsClient, tenantId)
    ]);

    const model = buildModel({
      lanes,
      workItems,
      events,
      customers,
      emailMessages,
      smsMessages,
      purchaseOrders,
      schedule,
      inventoryNeeds,
      inventoryItems
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
          "communications",
          "production-forecast",
          "cashflow-forecast",
          "seed-demo",
          "powerbi-config",
          "powerbi-embed"
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
