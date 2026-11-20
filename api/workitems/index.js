const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");
const { makeShopCalendar, readShopHours, workClock } = require("../_shared/shop-hours");
const { rememberPortalClosure } = require("../_shared/customer-portal");
const { vehicleMileagePatch } = require("../_shared/vehicle-mileage");

const T_ITEMS = "workitems";
const T_EVENTS = "events";

function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function flag(v, d = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return d;
}
module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  const id = context.bindingData && context.bindingData.id ? String(context.bindingData.id) : "";
  const tenantId = resolveTenantId(req, req && req.body ? req.body : {});

  if (method === "OPTIONS") { context.res = { status: 204 }; return; }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const items = TableClient.fromConnectionString(conn, T_ITEMS);
    const events = TableClient.fromConnectionString(conn, T_EVENTS);
    try { await items.createTable(); } catch (_) {}
    try { await events.createTable(); } catch (_) {}

    if (method === "GET") {
      const laneId = pick(req.query && req.query.laneId);
      const out = [];
      const customerId = pick(req.query && req.query.customerId);
      const filter = `PartitionKey eq '${tenantId}'`
        + (laneId ? ` and laneId eq '${laneId.replace(/'/g,"''")}'` : '')
        + (customerId ? ` and customerId eq '${customerId.replace(/'/g,"''")}'` : '');
      const iter = items.listEntities({ queryOptions: { filter } });
      const now = Date.now();
      let calendar;
      for await (const e of iter) {
        const createdAt = pick(e.createdAt) || (e.timestamp ? new Date(e.timestamp).toISOString() : "");
        if (e.checkedInAt && !calendar) calendar = makeShopCalendar(await readShopHours(conn, tenantId));
        const clock = calendar && e.checkedInAt ? workClock(e, calendar, now) : null;
        out.push({
          id: e.rowKey,
          title: pick(e.title),
          laneId: pick(e.laneId),
          customerId: pick(e.customerId),
          invoiceId: pick(e.invoiceId),
          jobId: pick(e.jobId),
          dashboardHidden: flag(e.dashboardHidden),
          customerName: pick(e.customerName),
          source: pick(e.source),
          leadSource: pick(e.leadSource),
          intakeSource: pick(e.intakeSource),
          origin: pick(e.origin),
          channel: pick(e.channel),
          contactEmail: pick(e.contactEmail),
          contactPhone: pick(e.contactPhone),
          message: pick(e.message),
          notes: pick(e.notes),
          customerNote: pick(e.customerNote),
          vin: pick(e.vin),
          vehicleId: pick(e.vehicleId),
          vehicleColor: pick(e.vehicleColor),
          vehicleYear: pick(e.vehicleYear),
          vehicleMake: pick(e.vehicleMake),
          vehicleModel: pick(e.vehicleModel),
          vehicleTrim: pick(e.vehicleTrim),
          mileageIn: e.mileageIn ?? null,
          mileageOut: e.mileageOut ?? null,
          mileageInRecordedAt: pick(e.mileageInRecordedAt),
          mileageOutRecordedAt: pick(e.mileageOutRecordedAt),
          sort: num(e.sort),
          createdAt,
          updatedAt: pick(e.updatedAt),
          checkedInAt: pick(e.checkedInAt),
          completedAt: pick(e.completedAt),
          pickedUpAt: pick(e.pickedUpAt),
          calendarOverrideAt: pick(e.calendarOverrideAt),
          isPaused: flag(e.isPaused, false),
          pausedAt: pick(e.pausedAt),
          lastWorkResumedAt: pick(e.lastWorkResumedAt),
          workDurationMs: num(e.workDurationMs, 0),
          workClockState: clock?.state || "not-started",
          activeWorkDurationMs: clock?.duration || 0,
          pauseDurationMs: num(e.pauseDurationMs, 0)
        });
      }
      out.sort((a,b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)) ||
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) ||
        ((b.sort ?? 0) - (a.sort ?? 0))
      );
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST" && req.url.includes("/reorder")) {
      const b = req.body || {};
      const laneId = pick(b.laneId);
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      for (let i = 0; i < ids.length; i++) await items.upsertEntity({ partitionKey: tenantId, rowKey: ids[i], sort: i * 10, laneId }, "Merge");
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
      return;
    }

    if (method === "POST") {
      const b = req.body || {};
      const rid = pick(b.id);
      const changeDashboardVisibility = b.op === "set-dashboard-visibility";
      if (changeDashboardVisibility && (!rid || typeof b.dashboardHidden !== "boolean")) {
        context.res = { status: 400, body: { error: "A card ID and dashboard visibility are required." } };
        return;
      }
      const title = pick(b.title).trim();
      const laneId = pick(b.laneId).trim();
      const customerId = pick(b.customerId).trim();
      const vin = Object.prototype.hasOwnProperty.call(b, "vin") ? pick(b.vin).trim() : null;
      const vehicleId = Object.prototype.hasOwnProperty.call(b, "vehicleId") ? pick(b.vehicleId).trim() : null;
      const vehicleYear = Object.prototype.hasOwnProperty.call(b, "vehicleYear") ? pick(b.vehicleYear).trim() : null;
      const vehicleMake = Object.prototype.hasOwnProperty.call(b, "vehicleMake") ? pick(b.vehicleMake).trim() : null;
      const vehicleModel = Object.prototype.hasOwnProperty.call(b, "vehicleModel") ? pick(b.vehicleModel).trim() : null;
      const vehicleTrim = Object.prototype.hasOwnProperty.call(b, "vehicleTrim") ? pick(b.vehicleTrim).trim() : null;
      const checkedInAt = Object.prototype.hasOwnProperty.call(b, "checkedInAt") ? pick(b.checkedInAt).trim() : null;
      const completedAt = Object.prototype.hasOwnProperty.call(b, "completedAt") ? pick(b.completedAt).trim() : null;
      const calendarOverrideAt = Object.prototype.hasOwnProperty.call(b, "calendarOverrideAt") ? pick(b.calendarOverrideAt).trim() : null;
      const isPaused = Object.prototype.hasOwnProperty.call(b, "isPaused") ? flag(b.isPaused, false) : null;
      const pausedAt = Object.prototype.hasOwnProperty.call(b, "pausedAt") ? pick(b.pausedAt).trim() : null;
      const lastWorkResumedAt = Object.prototype.hasOwnProperty.call(b, "lastWorkResumedAt")
        ? pick(b.lastWorkResumedAt).trim()
        : null;
      const workDurationMs = Object.prototype.hasOwnProperty.call(b, "workDurationMs") ? num(b.workDurationMs, 0) : null;
      const pauseDurationMs = Object.prototype.hasOwnProperty.call(b, "pauseDurationMs")
        ? num(b.pauseDurationMs, 0)
        : null;
      const clockAction = pick(b.workClockAction);
      if (clockAction && !["check-in", "start", "pause", "resume"].includes(clockAction)) {
        context.res = { status: 400, body: { error: "Invalid work clock action." } };
        return;
      }

      if (!rid && (!title || !laneId)) { context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "title and laneId required" } }; return; }

      if (!rid) {
        const documentId = title.match(/\[doc=([^\]]+)\]/i)?.[1]?.trim();
        if (documentId) {
          const settings = TableClient.fromConnectionString(conn, "appsettings");
          let reset;
          try { reset = await settings.getEntity(tenantId, "business.dataResetVersion"); }
          catch (error) { if (error.statusCode !== 404) throw error; }
          if (reset?.valueJson && JSON.parse(reset.valueJson)) {
            let document;
            try { document = await TableClient.fromConnectionString(conn, "servicedocuments").getEntity(tenantId, documentId); }
            catch (error) { if (error.statusCode !== 404) throw error; }
            if (!document || document.deleted) {
              context.res = { status: 409, body: { code: "BUSINESS_DATA_RESET", error: "This document is no longer available. Refresh the dashboard." } };
              return;
            }
          }
        }
        let max = 0;
        const iter = items.listEntities({ queryOptions: { filter: `PartitionKey eq '${tenantId}' and laneId eq '${laneId.replace(/'/g,"''")}'` } });
        for await (const e of iter) max = Math.max(max, num(e.sort));
        const rowKey = randomUUID();
        const now = new Date().toISOString();
        await items.upsertEntity({
          partitionKey: tenantId,
          rowKey,
          title,
          laneId,
          customerId,
          source: pick(b.source).trim() === "phone" ? "phone" : "",
          leadSource: pick(b.source).trim() === "phone" ? "phone" : "",
          message: pick(b.message).trim().slice(0, 1200),
          vehicleId: vehicleId || "",
          vin: vin || "",
          vehicleYear: vehicleYear || "",
          vehicleMake: vehicleMake || "",
          vehicleModel: vehicleModel || "",
          vehicleTrim: vehicleTrim || "",
          sort: max + 10,
          createdAt: now,
          updatedAt: now,
          calendarOverrideAt: "",
          isPaused: false,
          pausedAt: "",
          lastWorkResumedAt: "",
          workDurationMs: 0,
          pauseDurationMs: 0
        }, "Merge");
        await events.upsertEntity({ partitionKey: tenantId, rowKey: randomUUID(), type: "created", workItemId: rowKey, laneId, at: now }, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      } else {
        let existing = null;
        try {
          existing = await items.getEntity(tenantId, rid);
        } catch (e) {
          context.res = {
            status: 404,
            headers: { "content-type": "application/json" },
            body: { error: "Work item not found", detail: "This card no longer exists for the current location. Refresh the dashboard and try again." }
          };
          return;
        }
        if (changeDashboardVisibility) {
          await items.upsertEntity({ partitionKey: tenantId, rowKey: rid, dashboardHidden: b.dashboardHidden }, "Merge");
          context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rid } };
          return;
        }
        const prevLane = pick(existing.laneId);
        const moved = laneId && laneId !== prevLane;
        const patch = { partitionKey: tenantId, rowKey: rid, updatedAt: new Date().toISOString() };
        if (b.markPickedUp === true) {
          if (!existing.jobId || !existing.completedAt) {
            context.res = { status: 409, body: { error: "Complete this job before marking it picked up." } };
            return;
          }
          patch.pickedUpAt = pick(existing.pickedUpAt) || patch.updatedAt;
        }
        if (title) patch.title = title;
        if (laneId) patch.laneId = laneId;
        if (customerId) patch.customerId = customerId;
        if (vin !== null) patch.vin = vin;
        if (vehicleId !== null) patch.vehicleId = vehicleId;
        if (vehicleYear !== null) patch.vehicleYear = vehicleYear;
        if (vehicleMake !== null) patch.vehicleMake = vehicleMake;
        if (vehicleModel !== null) patch.vehicleModel = vehicleModel;
        if (vehicleTrim !== null) patch.vehicleTrim = vehicleTrim;
        if (checkedInAt !== null) patch.checkedInAt = checkedInAt;
        if (completedAt !== null) patch.completedAt = completedAt;
        if (completedAt === "" && existing.completedAt) patch.pickedUpAt = "";
        if (calendarOverrideAt !== null) patch.calendarOverrideAt = calendarOverrideAt;
        if (isPaused !== null) patch.isPaused = isPaused;
        if (pausedAt !== null) patch.pausedAt = pausedAt;
        if (lastWorkResumedAt !== null) patch.lastWorkResumedAt = lastWorkResumedAt;
        if (workDurationMs !== null) patch.workDurationMs = workDurationMs;
        if (pauseDurationMs !== null) patch.pauseDurationMs = pauseDurationMs;

        if (clockAction === "check-in" && checkedInAt && !existing.checkedInAt) {
          Object.assign(patch, {
            workClockVersion: 2, checkedInAt: patch.updatedAt,
            isPaused: false, pausedAt: "", lastWorkResumedAt: "", workDurationMs: 0, pauseDurationMs: 0
          });
        } else if (clockAction === "check-in") {
          context.res = { status: 409, body: { error: "This job has already been checked in." } };
          return;
        } else if (existing.checkedInAt && !existing.completedAt && (clockAction || completedAt || isPaused !== null)) {
          const calendar = makeShopCalendar(await readShopHours(conn, tenantId));
          const now = Date.parse(patch.updatedAt);
          const clock = workClock(existing, calendar, now);
          if (clockAction === "start" && clock.state === "not-started") {
            Object.assign(patch, { lastWorkResumedAt: patch.updatedAt, pausedAt: "", isPaused: false, workClockVersion: 2 });
          } else if ((clockAction === "pause" || isPaused === true) && ["working", "after-hours"].includes(clock.state)) {
            Object.assign(patch, { lastWorkResumedAt: "", pausedAt: patch.updatedAt, isPaused: true,
              workDurationMs: clock.duration, workClockVersion: 2 });
          } else if ((clockAction === "resume" || isPaused === false) && clock.state === "paused" && !completedAt && checkedInAt !== "") {
            const pausedSince = Date.parse(existing.pausedAt);
            Object.assign(patch, { lastWorkResumedAt: patch.updatedAt, pausedAt: "", isPaused: false,
              workDurationMs: clock.duration,
              pauseDurationMs: num(existing.pauseDurationMs) + (Number.isFinite(pausedSince) ? Math.max(0, now - pausedSince) : 0),
              workClockVersion: 2 });
          } else if (clockAction) {
            context.res = { status: 409, body: { error: "Refresh the job before changing its work clock." } };
            return;
          }
          if (completedAt) {
            Object.assign(patch, { workDurationMs: clock.duration, isPaused: false, pausedAt: "", lastWorkResumedAt: "" });
          }
        } else if (clockAction) {
          context.res = { status: 409, body: { error: "Check in this job before starting work." } };
          return;
        }
        Object.assign(patch, await vehicleMileagePatch(conn, tenantId, existing, patch, b, principal));
        await items.upsertEntity(patch, "Merge");
        if (b.markPickedUp === true && existing.invoiceId) {
          await rememberPortalClosure(tenantId, existing.invoiceId).catch(() => {});
        }
        if (moved) {
          let max = 0;
          const iter = items.listEntities({ queryOptions: { filter: `PartitionKey eq '${tenantId}' and laneId eq '${laneId.replace(/'/g,"''")}'` } });
          for await (const e of iter) max = Math.max(max, num(e.sort));
          await items.upsertEntity({ partitionKey: tenantId, rowKey: rid, sort: max + 10 }, "Merge");
          await events.upsertEntity({ partitionKey: tenantId, rowKey: randomUUID(), type: "moved", workItemId: rid, fromLaneId: prevLane, toLaneId: laneId, at: new Date().toISOString() }, "Merge");

        }
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rid, moved } };
        return;
      }
    }

    if (method === "DELETE" && id) {
      try {
        const item = await items.getEntity(tenantId, id);
        if (item.jobId) {
          context.res = { status: 409, body: { error: "Paid jobs remain in the service history." } };
          return;
        }
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
      await items.deleteEntity(tenantId, id);
      await events.upsertEntity({ partitionKey: tenantId, rowKey: randomUUID(), type: "deleted", workItemId: id, at: new Date().toISOString() }, "Merge");
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
      return;
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    const status = err.statusCode === 400 ? 400 : 500;
    context.res = { status, headers: { "content-type": "application/json" }, body: { error: status === 400 ? err.message : "Server error", detail: String(err && err.message || err) } };
  }
};
