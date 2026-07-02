const { TableClient } = require("../_shared/table-client");
const { createHash } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const TABLE = "jobtasks";
const DAY_MS = 24 * 60 * 60 * 1000;

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {}
  }
  return {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return [];
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
}

function queryParam(req, key) {
  if (req.query && req.query[key] != null) return asString(req.query[key]);
  const rawUrl = asString(req.url);
  if (!rawUrl || rawUrl.indexOf("?") < 0) return "";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

async function getTableClient() {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, TABLE);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

function normalizeStatus(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "in_progress" || normalized === "in-progress") return "in_progress";
  if (normalized === "completed") return "completed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "open";
}

function normalizePriority(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "high") return "high";
  if (normalized === "low") return "low";
  return "normal";
}

function toTask(entity) {
  return {
    id: asString(entity.rowKey),
    taskType: asString(entity.taskType),
    jobId: asString(entity.jobId),
    jobNumber: asString(entity.jobNumber),
    relatedScheduleId: asString(entity.relatedScheduleId),
    relatedWorkItemId: asString(entity.relatedWorkItemId),
    customerName: asString(entity.customerName),
    vehicle: asString(entity.vehicle),
    title: asString(entity.title),
    description: asString(entity.description),
    assignedRole: asString(entity.assignedRole),
    ownerRole: asString(entity.ownerRole),
    ownerUser: asString(entity.ownerUser),
    dueDate: asString(entity.dueDate),
    priority: normalizePriority(entity.priority),
    status: normalizeStatus(entity.status),
    comments: asString(entity.comments),
    warning: asString(entity.warning),
    completedAt: asString(entity.completedAt),
    completedBy: asString(entity.completedBy),
    completedById: asString(entity.completedById),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt)
  };
}

function byDueDate(a, b) {
  const ta = Date.parse(asString(a.dueDate));
  const tb = Date.parse(asString(b.dueDate));
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  if (Number.isFinite(ta)) return -1;
  if (Number.isFinite(tb)) return 1;
  return asString(b.updatedAt || b.createdAt).localeCompare(asString(a.updatedAt || a.createdAt));
}

async function listTasks(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(toTask(entity));
  return out.sort(byDueDate);
}

function matchesQuery(task, query) {
  const jobId = asString(query.jobId);
  const jobNumber = asString(query.jobNumber);
  const scheduleId = asString(query.scheduleId);
  const workItemId = asString(query.workItemId);
  const status = asString(query.status).toLowerCase();
  if (jobId && task.jobId !== jobId) return false;
  if (jobNumber && task.jobNumber !== jobNumber) return false;
  if (scheduleId && task.relatedScheduleId !== scheduleId) return false;
  if (workItemId && task.relatedWorkItemId !== workItemId) return false;
  if (status && status !== "all" && task.status !== status) return false;
  return true;
}

function isoDateAtLocalStart(value, offsetDays) {
  const ts = Date.parse(asString(value));
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts + offsetDays * DAY_MS);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function taskId(tenantId, jobKey, taskType, dueDate) {
  return createHash("sha1")
    .update([tenantId, jobKey, taskType, dueDate].join("|"))
    .digest("hex");
}

function jobKeyFrom(body) {
  return asString(body.jobId) || (asString(body.jobNumber) ? `job-number:${asString(body.jobNumber)}` : "") || asString(body.relatedScheduleId);
}

function partWarnings(parts, additionalParts, mode) {
  const warnings = [];
  const rows = asArray(parts);
  const additions = asArray(additionalParts).filter(part => {
    const approval = asString(part.approvalStatus).toLowerCase();
    const review = asString(part.invoiceReviewStatus).toLowerCase();
    return approval === "approved" || review === "needs_review";
  });

  if (mode === "readiness") {
    const notReceived = rows.filter(part => Number(part.qtyReceived || 0) < Number(part.qtyNeeded || 0));
    const backordered = rows.filter(part => asString(part.status).toLowerCase() === "backordered");
    if (notReceived.length) warnings.push(`${notReceived.length} required part(s) not fully received.`);
    if (backordered.length) warnings.push(`${backordered.length} required part(s) backordered.`);
    if (additions.length) warnings.push(`${additions.length} additional part(s) need approval/review consideration.`);
  } else {
    const notPulled = rows.filter(part => Number(part.qtyReceived || 0) > 0 && Number(part.qtyPulled || 0) < Number(part.qtyNeeded || 0));
    if (notPulled.length) warnings.push(`${notPulled.length} received part(s) not fully pulled.`);
    if (additions.length) warnings.push(`${additions.length} additional part(s) may need to be pulled or reviewed.`);
  }
  return warnings.join(" ");
}

function baseTaskFields(body) {
  return {
    jobId: asString(body.jobId),
    jobNumber: asString(body.jobNumber),
    relatedScheduleId: asString(body.relatedScheduleId),
    relatedWorkItemId: asString(body.relatedWorkItemId),
    customerName: asString(body.customerName),
    vehicle: asString(body.vehicle),
    assignedRole: asString(body.assignedRole) || "Inventory / Front Desk",
    ownerRole: asString(body.ownerRole) || "Inventory Manager",
    ownerUser: asString(body.ownerUser),
    priority: normalizePriority(body.priority || "normal")
  };
}

async function upsertGeneratedTask(client, tenantId, body, taskType, title, description, dueDate, warning) {
  const jobKey = jobKeyFrom(body);
  if (!jobKey || !dueDate) return null;
  const id = taskId(tenantId, jobKey, taskType, dueDate);
  const now = new Date().toISOString();
  let existing = null;
  try {
    existing = await client.getEntity(tenantId, id);
  } catch (_) {}

  const entity = {
    partitionKey: tenantId,
    rowKey: id,
    taskType,
    ...baseTaskFields(body),
    title,
    description,
    dueDate,
    warning: asString(warning),
    status: normalizeStatus(existing && existing.status),
    comments: asString(existing && existing.comments),
    completedAt: asString(existing && existing.completedAt),
    completedBy: asString(existing && existing.completedBy),
    completedById: asString(existing && existing.completedById),
    createdAt: asString(existing && existing.createdAt) || now,
    updatedAt: now
  };
  await client.upsertEntity(entity, "Merge");
  const saved = await client.getEntity(tenantId, id);
  return toTask(saved);
}

async function ensurePartsTasks(client, tenantId, body) {
  const installDate = asString(body.installDate);
  const parts = asArray(body.parts);
  if (!installDate || !parts.length) return [];
  const readinessDue = isoDateAtLocalStart(installDate, -7);
  const pullDue = isoDateAtLocalStart(installDate, -1);
  const additionalParts = asArray(body.additionalParts);
  const tasks = [];
  const readiness = await upsertGeneratedTask(
    client,
    tenantId,
    body,
    "parts-readiness",
    "Confirm all parts are ready for install",
    "Confirm all required parts are received or accounted for.",
    readinessDue,
    partWarnings(parts, additionalParts, "readiness")
  );
  if (readiness) tasks.push(readiness);
  const pull = await upsertGeneratedTask(
    client,
    tenantId,
    body,
    "parts-pull",
    "Pull parts for install",
    "Pull all received parts and confirm readiness for technician.",
    pullDue,
    partWarnings(parts, additionalParts, "pull")
  );
  if (pull) tasks.push(pull);
  return tasks;
}

function taskEntityFromBody(id, body, existing, principal) {
  const now = new Date().toISOString();
  const status = normalizeStatus(body.status || (existing && existing.status));
  const completedAt = status === "completed"
    ? asString(body.completedAt || (existing && existing.completedAt) || now)
    : asString(body.completedAt || (existing && existing.completedAt));
  return {
    partitionKey: asString(body.tenantId),
    rowKey: id,
    taskType: asString(body.taskType || (existing && existing.taskType) || "manual"),
    ...baseTaskFields({ ...(existing || {}), ...body }),
    title: asString(body.title || (existing && existing.title)),
    description: asString(body.description || (existing && existing.description)),
    dueDate: asString(body.dueDate || (existing && existing.dueDate)),
    status,
    comments: asString(body.comments || (existing && existing.comments)),
    warning: asString(body.warning || (existing && existing.warning)),
    completedAt,
    completedBy: status === "completed"
      ? asString(body.completedBy || (existing && existing.completedBy) || (principal && (principal.displayName || principal.email)))
      : asString(body.completedBy || (existing && existing.completedBy)),
    completedById: status === "completed"
      ? asString(body.completedById || (existing && existing.completedById) || (principal && (principal.userId || principal.email)))
      : asString(body.completedById || (existing && existing.completedById)),
    createdAt: asString(existing && existing.createdAt) || asString(body.createdAt) || now,
    updatedAt: now
  };
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const body = asObject(req.body);
  const tenantId = resolveTenantId(req, body);
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    const client = await getTableClient();
    if (method === "GET") {
      const id = queryParam(req, "id");
      if (id) {
        try {
          const entity = await client.getEntity(tenantId, id);
          context.res = json(200, { ok: true, task: toTask(entity) });
        } catch (_) {
          context.res = json(404, { error: "Task not found." });
        }
        return;
      }
      const query = {
        jobId: queryParam(req, "jobId"),
        jobNumber: queryParam(req, "jobNumber"),
        scheduleId: queryParam(req, "scheduleId"),
        workItemId: queryParam(req, "workItemId"),
        status: queryParam(req, "status")
      };
      const tasks = (await listTasks(client, tenantId)).filter(task => matchesQuery(task, query));
      context.res = json(200, { ok: true, tasks });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op || body.operation || body.action || "upsert").toLowerCase();
    if (op === "ensurepartstasks" || op === "ensure-parts-tasks") {
      const tasks = await ensurePartsTasks(client, tenantId, body);
      context.res = json(200, { ok: true, tasks });
      return;
    }

    if (op !== "create" && op !== "update" && op !== "upsert" && op !== "complete") {
      context.res = json(400, { error: "Unknown operation." });
      return;
    }

    const id = asString(body.id) || taskId(tenantId, jobKeyFrom(body) || "manual", asString(body.taskType || body.title), asString(body.dueDate || Date.now()));
    let existing = null;
    if (asString(body.id)) {
      try {
        existing = await client.getEntity(tenantId, id);
      } catch (_) {}
    }
    const nextBody = op === "complete" ? { ...body, status: "completed" } : body;
    const entity = taskEntityFromBody(id, { ...nextBody, tenantId }, existing, principal);
    if (!entity.title) {
      context.res = json(400, { error: "title is required." });
      return;
    }
    await client.upsertEntity(entity, "Merge");
    const saved = await client.getEntity(tenantId, id);
    context.res = json(200, { ok: true, task: toTask(saved) });
  } catch (err) {
    if (context.log && typeof context.log.error === "function") context.log.error(err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
