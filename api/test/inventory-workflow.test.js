const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const BASE_URL = String(process.env.PATHFLOW_WORKFLOW_QA_BASE_URL || "").replace(/\/+$/, "");

function localOnlyBaseUrl() {
  if (!BASE_URL) return "";
  const parsed = new URL(BASE_URL);
  const host = parsed.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("PATHFLOW_WORKFLOW_QA_BASE_URL must point at a local Functions host.");
  }
  return BASE_URL;
}

function rowKeyForInventoryNeed(invoiceId, line) {
  const lineId = String(line && line.id || "").trim();
  const partName = String(line && (line.description || line.code || line.partName) || "").trim();
  const hash = crypto
    .createHash("sha1")
    .update([invoiceId, lineId, partName].join("|"))
    .digest("hex")
    .slice(0, 20);
  return `invoice-part-${hash}`;
}

function qaHeaders(tenantId) {
  return {
    "content-type": "application/json",
    "x-tenant-id": tenantId,
    "x-dev-user-email": "workflow-qa-admin@pathflow.local",
    "x-dev-user-name": "Workflow QA Admin",
    "x-dev-user-roles": "authenticated,admin"
  };
}

async function api(method, path, tenantId, body) {
  const res = await fetch(`${localOnlyBaseUrl()}${path}`, {
    method,
    headers: qaHeaders(tenantId),
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  assert.ok(res.ok, `${method} ${path} should succeed: ${res.status} ${text}`);
  return payload;
}

function findNeed(needs, id) {
  return needs.find(need => need.id === id);
}

function jobDetailCompatiblePayload({ inventory, purchaseOrders, tasks, attachments, jobNumber }) {
  const needs = inventory.needs.filter(need => need.jobNumber === jobNumber);
  const needIds = new Set(needs.map(need => need.id));
  const connectedOrders = purchaseOrders.items
    .map(order => ({
      order,
      lines: order.lines.filter(line => needIds.has(line.needId))
    }))
    .filter(row => row.lines.length);
  return {
    jobNumber,
    parts: needs,
    purchaseOrders: connectedOrders,
    tasks: tasks.tasks,
    attachments: attachments.attachments,
    partsReadiness: needs.every(need => Number(need.qtyReceived || 0) >= Number(need.qtyNeeded || need.qty || 0))
      ? "Ready"
      : `${needs.filter(need => Number(need.qtyReceived || 0) < Number(need.qtyNeeded || need.qty || 0)).length} part(s) not fully received`
  };
}

test("local seeded paid invoice to job-parts workflow", { skip: !BASE_URL }, async () => {
  const runId = `qa-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const tenantId = `workflow-${runId}`;
  const customerId = `customer-${runId}`;
  const invoiceId = `invoice-${runId}`;
  const invoiceNumber = `INV-${runId}`;
  const jobNumber = `JOB-${runId}`;
  const installDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const customerName = "Workflow QA Customer";
  const vehicle = "2026 Jeep Wrangler";
  const partLineA = {
    id: `line-part-a-${runId}`,
    type: "part",
    code: `QA-LIFT-${runId}`,
    description: "QA Lift Kit",
    quantity: 4,
    unitPrice: 250,
    relatedInventoryItemId: `stock-lift-${runId}`
  };
  const partLineB = {
    id: `line-part-b-${runId}`,
    type: "part",
    code: `QA-BOLT-${runId}`,
    description: "QA Bolt Pack",
    quantity: 1,
    unitPrice: 45,
    relatedInventoryItemId: `stock-bolt-${runId}`
  };
  const laborLine = {
    id: `line-labor-${runId}`,
    type: "labor",
    code: "LABOR",
    description: "Install labor",
    quantity: 5,
    unitPrice: 150
  };
  const needIdA = rowKeyForInventoryNeed(invoiceId, partLineA);
  const needIdB = rowKeyForInventoryNeed(invoiceId, partLineB);

  await api("POST", "/api/customers", tenantId, {
    op: "import",
    rows: [{
      id: customerId,
      firstName: "Workflow",
      lastName: "QA Customer",
      email: `workflow-${runId}@example.test`,
      phone: "555-0100",
      vehicleYear: "2026",
      vehicleMake: "Jeep",
      vehicleModel: "Wrangler"
    }]
  });

  await api("POST", "/api/inventory", tenantId, {
    op: "upsertItem",
    id: partLineA.relatedInventoryItemId,
    name: partLineA.description,
    sku: partLineA.code,
    vendor: "QA Supplier",
    unitCost: 100,
    onHand: 0,
    onOrder: 0
  });
  await api("POST", "/api/inventory", tenantId, {
    op: "upsertItem",
    id: partLineB.relatedInventoryItemId,
    name: partLineB.description,
    sku: partLineB.code,
    vendor: "QA Supplier",
    unitCost: 15,
    onHand: 0,
    onOrder: 0
  });

  const paidPayload = {
    op: "record-manual-payment",
    action: "pay",
    invoiceId,
    invoiceNumber,
    jobNumber,
    customerId,
    customerName,
    vehicle,
    paymentAmount: 1795,
    lineItems: [partLineA, laborLine, partLineB]
  };
  await api("GET", "/api/lanes", tenantId);
  const paidOnce = await api("POST", "/api/invoice-response", tenantId, paidPayload);
  assert.equal(paidOnce.inventoryNeedsCreated, 2, "paid invoice creates one inventory need per part line");
  const jobs = (await api("GET", "/api/workitems", tenantId)).filter(item => item.invoiceId === invoiceId);
  assert.equal(jobs.length, 1, "paid invoice produces one durable dashboard job");
  const lanes = await api("GET", "/api/lanes", tenantId);
  const job = jobs[0];
  await api("POST", "/api/settings", tenantId, {
    op: "set", key: "schedule.settings", value: { openHour: 0, closeHour: 24, showWeekends: true, timeZone: "America/Chicago" }
  });
  const jobAppointment = await api("POST", "/api/schedule", tenantId, {
    start: installDate, end: new Date(Date.parse(installDate) + 3600000).toISOString(),
    resource: "bay-1", customerId, workItemId: job.id
  });
  const appointments = await api("GET", "/api/schedule", tenantId);
  assert.equal(appointments.find(item => item.id === jobAppointment.id)?.workItemId, job.id);
  await api("POST", "/api/workitems", tenantId, {
    id: job.id, laneId: lanes.find(lane => lane.stageKey === "inprogress").id,
    workClockAction: "check-in", checkedInAt: new Date().toISOString()
  });
  async function readClock() {
    return (await api("GET", "/api/workitems", tenantId)).find(item => item.id === job.id).workClockState;
  }
  assert.equal(await readClock(), "not-started");
  await api("POST", "/api/workitems", tenantId, { id: job.id, workClockAction: "start" });
  assert.equal(await readClock(), "working");
  await api("POST", "/api/workitems", tenantId, { id: job.id, workClockAction: "pause" });
  assert.equal(await readClock(), "paused");
  await api("POST", "/api/workitems", tenantId, {
    id: job.id, laneId: lanes.find(lane => lane.stageKey === "completed").id, completedAt: new Date().toISOString()
  });
  await api("POST", "/api/workitems", tenantId, { id: job.id, markPickedUp: true });
  assert.ok((await api("GET", "/api/workitems", tenantId)).find(item => item.id === job.id).pickedUpAt);

  let notifications = await api("GET", "/api/notifications?scope=all&limit=25", tenantId);
  assert.equal(notifications.unreadCount, 2, "paid invoice creates one paid notice and one parts-to-order notice");

  const paidTwice = await api("POST", "/api/invoice-response", tenantId, paidPayload);
  assert.equal(paidTwice.jobId, paidOnce.jobId, "replaying the payment keeps the same job");
  assert.equal(paidTwice.inventoryNeedsCreated, 2, "paid bridge upserts deterministic needs on rerun");
  notifications = await api("GET", "/api/notifications?scope=all&limit=25", tenantId);
  assert.equal(notifications.unreadCount, 2, "rerunning the paid bridge does not duplicate visible notifications");

  await api("POST", "/api/notifications", tenantId, {
    op: "markReadBatch",
    ids: notifications.items.map(item => item.id)
  });
  notifications = await api("GET", "/api/notifications?scope=all&limit=25", tenantId);
  assert.equal(notifications.unreadCount, 0, "paid invoice notifications can be marked read");

  await api("POST", "/api/invoice-response", tenantId, paidPayload);
  notifications = await api("GET", "/api/notifications?scope=all&limit=25", tenantId);
  assert.equal(notifications.unreadCount, 0, "rerunning the paid bridge does not reopen read notifications");

  let inventory = await api("GET", "/api/inventory", tenantId);
  const jobNeeds = inventory.needs.filter(need => need.jobNumber === jobNumber);
  assert.equal(jobNeeds.length, 2, "labor lines are ignored and duplicate need rows are not created");
  assert.ok(findNeed(jobNeeds, needIdA), "deterministic need id for first part exists");
  assert.ok(findNeed(jobNeeds, needIdB), "deterministic need id for second part exists");
  assert.ok(jobNeeds.every(need => need.status === "needs-order"), "paid invoice needs appear in To Order-compatible state");
  assert.ok(jobNeeds.every(need => need.relatedInvoiceId === invoiceId), "needs retain related invoice id");

  const draft = await api("POST", "/api/purchase-orders", tenantId, {
    op: "createDraft",
    needIds: [needIdA],
    supplier: "QA Supplier",
    note: "Workflow QA draft PO"
  });
  assert.equal(draft.order.status, "draft", "PO draft is created");
  assert.equal(draft.order.lines.length, 1, "PO draft only includes requested need");
  assert.equal(draft.order.lines[0].needId, needIdA, "PO line carries inventoryneed/job-part reference");
  assert.equal(draft.order.lines[0].qty, 4, "PO draft quantity is remaining needed quantity");

  inventory = await api("GET", "/api/inventory?scope=needs", tenantId);
  let needA = findNeed(inventory.needs, needIdA);
  assert.equal(needA.status, "po-draft", "PO draft marks need as draft-linked");
  assert.equal(needA.purchaseOrderId, draft.order.id, "need references draft PO id");

  const submitted = await api("POST", "/api/purchase-orders", tenantId, {
    op: "submit",
    id: draft.order.id
  });
  assert.equal(submitted.order.status, "ordered", "PO submit moves order to ordered");

  const vendorEmail = await api("POST", "/api/parts-email-intake", tenantId, {
    purchaseOrderId: draft.order.id,
    lineId: submitted.order.lines[0].lineId,
    from: "orders@qa-supplier.example.test",
    to: "parts@example.test",
    subject: `QA Supplier order ORDER-${runId} has shipped`,
    message: [
      `Purchase Order: ORDER-${runId}`,
      `SKU: ${partLineA.code}`,
      `Tracking #: TRACK-${runId}`,
      "Carrier: USPS",
      `ETA: ${installDate.slice(0, 10)}`,
      `Vendor Invoice #: VENDOR-INV-${runId}`
    ].join("\n")
  });
  assert.equal(vendorEmail.matched, true, "fake vendor email matches the submitted PO line");
  assert.equal(vendorEmail.line.orderNumber, `ORDER-${runId}`, "vendor email parser updates PO line order number");
  assert.equal(vendorEmail.line.trackingNumber, `TRACK-${runId}`, "vendor email parser updates PO line tracking number");
  assert.equal(vendorEmail.line.carrier, "USPS", "vendor email parser updates PO line carrier");
  assert.equal(vendorEmail.line.etaDate, installDate.slice(0, 10), "vendor email parser updates PO line ETA");
  assert.equal(vendorEmail.line.vendorInvoiceNumber, `VENDOR-INV-${runId}`, "vendor email parser updates vendor invoice number");

  inventory = await api("GET", "/api/inventory?scope=needs", tenantId);
  needA = findNeed(inventory.needs, needIdA);
  assert.equal(needA.status, "ordered", "PO submit moves need to ordered");
  assert.equal(needA.jobPartStatus, "ordered", "PO submit maps job-part status to ordered");
  assert.equal(Number(needA.qtyOrdered), 4, "PO submit updates qtyOrdered exactly once");

  const inventoryItemsAfterSubmit = await api("GET", "/api/inventory?scope=items", tenantId);
  let stockA = inventoryItemsAfterSubmit.items.find(item => item.id === partLineA.relatedInventoryItemId);
  assert.equal(Number(stockA.onHand), 0, "submitting PO does not change on-hand stock");
  assert.equal(Number(stockA.onOrder), 4, "submitting PO increases on-order quantity");

  const partiallyReceived = await api("POST", "/api/purchase-orders", tenantId, {
    op: "receive",
    id: draft.order.id,
    receipts: [{
      lineId: submitted.order.lines[0].lineId,
      qtyReceived: 2,
      orderNumber: `ORDER-${runId}`,
      trackingNumber: `TRACK-${runId}`,
      etaDate: installDate,
      vendorInvoiceNumber: `VENDOR-INV-${runId}`,
      note: "Partial receive QA"
    }]
  });
  assert.equal(partiallyReceived.order.status, "ordered", "partial receive keeps PO open");
  assert.equal(Number(partiallyReceived.order.lines[0].qtyReceived), 2, "PO line records partial received quantity");

  inventory = await api("GET", "/api/inventory?scope=needs", tenantId);
  needA = findNeed(inventory.needs, needIdA);
  assert.equal(Number(needA.qtyReceived), 2, "partial receive updates inventoryneed qtyReceived by delta");
  assert.equal(needA.status, "ordered", "partial received need remains ordered until complete");

  let inventoryItems = await api("GET", "/api/inventory?scope=items", tenantId);
  stockA = inventoryItems.items.find(item => item.id === partLineA.relatedInventoryItemId);
  assert.equal(Number(stockA.onHand), 2, "partial receive increases on-hand by received delta");
  assert.equal(Number(stockA.onOrder), 2, "partial receive reduces on-order by received delta");

  const duplicatePartialReceive = await fetch(`${localOnlyBaseUrl()}/api/purchase-orders`, {
    method: "POST",
    headers: qaHeaders(tenantId),
    body: JSON.stringify({
      op: "receive",
      id: draft.order.id,
      receipts: [{ lineId: submitted.order.lines[0].lineId, qtyReceived: 0 }]
    })
  });
  assert.equal(duplicatePartialReceive.status, 400, "zero-quantity re-receive is rejected instead of changing stock");

  await api("POST", "/api/purchase-orders", tenantId, {
    op: "receive",
    id: draft.order.id,
    receipts: [{
      lineId: submitted.order.lines[0].lineId,
      qtyReceived: 2,
      orderNumber: `ORDER-${runId}`,
      trackingNumber: `TRACK-${runId}`,
      etaDate: installDate,
      vendorInvoiceNumber: `VENDOR-INV-${runId}`,
      note: "Final receive QA"
    }]
  });

  const finalPo = await api("GET", `/api/purchase-orders?id=${encodeURIComponent(draft.order.id)}`, tenantId);
  assert.equal(finalPo.order.status, "received", "fully received PO moves to received");
  assert.equal(Number(finalPo.order.lines[0].qtyReceived), 4, "PO line records full received quantity");

  inventory = await api("GET", "/api/inventory", tenantId);
  needA = findNeed(inventory.needs, needIdA);
  assert.equal(needA.status, "received", "fully received need moves to received");
  assert.equal(needA.jobPartStatus, "received", "fully received job part moves to received");
  assert.equal(Number(needA.qtyReceived), 4, "fully received need records total received quantity");
  const needB = findNeed(inventory.needs, needIdB);
  assert.equal(needB.status, "needs-order", "unselected part remains in To Order-compatible state");

  inventoryItems = await api("GET", "/api/inventory?scope=items", tenantId);
  stockA = inventoryItems.items.find(item => item.id === partLineA.relatedInventoryItemId);
  assert.equal(Number(stockA.onHand), 4, "full receive only adds the final received delta to on-hand");
  assert.equal(Number(stockA.onOrder), 0, "full receive clears on-order for received line");

  const taskPayload = {
    op: "ensurePartsTasks",
    jobId: `job-number:${jobNumber}`,
    jobNumber,
    relatedScheduleId: `schedule-${runId}`,
    relatedWorkItemId: `work-${runId}`,
    customerName,
    vehicle,
    installDate,
    parts: inventory.needs
      .filter(need => need.jobNumber === jobNumber)
      .map(need => ({
        id: need.id,
        status: need.jobPartStatus || need.status,
        qtyNeeded: Number(need.qtyNeeded || need.qty || 0),
        qtyReceived: Number(need.qtyReceived || 0),
        qtyPulled: Number(need.qtyPulled || 0)
      }))
  };
  const tasksOnce = await api("POST", "/api/job-tasks", tenantId, taskPayload);
  const tasksTwice = await api("POST", "/api/job-tasks", tenantId, taskPayload);
  assert.equal(tasksOnce.tasks.length, 2, "parts readiness and pull tasks are generated");
  assert.equal(tasksTwice.tasks.length, 2, "task generation returns existing generated tasks on rerun");
  assert.deepEqual(
    tasksTwice.tasks.map(task => task.id).sort(),
    tasksOnce.tasks.map(task => task.id).sort(),
    "generated task ids are deterministic and not duplicated"
  );

  const taskList = await api("GET", `/api/job-tasks?jobNumber=${encodeURIComponent(jobNumber)}`, tenantId);
  const scheduledPartTasks = taskList.tasks.filter(task => task.taskType === "parts-readiness" || task.taskType === "parts-pull");
  assert.equal(scheduledPartTasks.length, 2, "task list has no duplicate generated readiness/pull tasks");
  assert.equal(
    new Set(scheduledPartTasks.map(task => task.id)).size,
    scheduledPartTasks.length,
    "generated readiness/pull task ids are unique"
  );
  assert.ok(
    taskList.tasks.some(task => /not fully received/i.test(task.warning)),
    "readiness warning reflects the still-unordered second part"
  );

  const attachment = await api("POST", "/api/attachments", tenantId, {
    op: "upload",
    jobId: `job-number:${jobNumber}`,
    jobNumber,
    relatedInventoryNeedId: needIdA,
    relatedPurchaseOrderId: draft.order.id,
    fileName: `workflow-${runId}.pdf`,
    originalFileName: `workflow-${runId}.pdf`,
    contentType: "application/pdf",
    fileBase64: Buffer.from("%PDF-1.4\n% workflow qa\n").toString("base64"),
    category: "vendor_invoice",
    description: "Workflow QA vendor invoice attachment"
  });
  assert.equal(attachment.attachment.category, "vendor_invoice", "vendor invoice attachment is saved");

  const attachments = await api("GET", `/api/attachments?jobNumber=${encodeURIComponent(jobNumber)}`, tenantId);
  assert.equal(attachments.attachments.length, 1, "Job Detail attachment source query sees uploaded attachment");

  const purchaseOrders = await api("GET", "/api/purchase-orders", tenantId);
  const jobDetail = jobDetailCompatiblePayload({ inventory, purchaseOrders, tasks: taskList, attachments, jobNumber });
  assert.equal(jobDetail.parts.length, 2, "Job Detail-compatible payload includes connected job parts");
  assert.equal(jobDetail.purchaseOrders.length, 1, "Job Detail-compatible payload includes connected PO");
  assert.equal(jobDetail.purchaseOrders[0].lines[0].needId, needIdA, "connected PO line points at job part");
  assert.ok(jobDetail.tasks.length >= 2, "Job Detail-compatible payload includes connected tasks");
  assert.equal(
    jobDetail.tasks.filter(task => task.taskType === "parts-readiness" || task.taskType === "parts-pull").length,
    2,
    "Job Detail-compatible payload includes generated readiness and pull tasks"
  );
  assert.equal(jobDetail.attachments.length, 1, "Job Detail-compatible payload includes attachment list for print packet context");
  assert.equal(jobDetail.partsReadiness, "1 part(s) not fully received", "Job Detail-compatible readiness reports remaining missing part");

  const access = await api("GET", "/api/access", tenantId);
  assert.equal(access.ok, true, "admin dev principal can read access profile");
  assert.equal(access.profile?.areaAccess && Object.keys(access.profile.areaAccess).length, 0, "admin access is unrestricted by area toggles");
});
