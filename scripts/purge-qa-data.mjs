const baseUrl = String(process.env.QA_API_BASE_URL || 'http://localhost:7071').replace(/\/+$/, '');
const tenantId = String(process.env.QA_PURGE_TENANT || 'main').trim() || 'main';

function isQaCustomerRecord(record) {
  const name = String(record?.name || '').trim().toLowerCase();
  const email = String(record?.email || '').trim().toLowerCase();
  const secondaryEmail = String(record?.secondaryEmail || '').trim().toLowerCase();
  return /^qa(?:\b|[-\s_])/.test(name) || email.endsWith('@example.com') || secondaryEmail.endsWith('@example.com');
}

function isQaScheduleRecord(record, qaCustomerIds) {
  const customerId = String(record?.customerId || '').trim();
  if (customerId && qaCustomerIds.has(customerId)) return true;
  const title = String(record?.title || '').trim().toLowerCase();
  const notes = String(record?.notes || '').trim().toLowerCase();
  return title.includes('qa') || notes.includes('qa');
}

function isQaWorkItemRecord(record, qaCustomerIds) {
  const customerId = String(record?.customerId || '').trim();
  if (customerId && qaCustomerIds.has(customerId)) return true;
  const title = String(record?.title || '').trim().toLowerCase();
  return /^qa(?:\b|[-\s_])/.test(title);
}

async function api(path, init = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-tenant-id': tenantId,
    ...(init.headers || {})
  };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, body };
}

async function run() {
  const customersRes = await api('/api/customers');
  const customers = Array.isArray(customersRes.body)
    ? customersRes.body
    : (Array.isArray(customersRes.body?.items) ? customersRes.body.items : []);
  const qaCustomers = customers.filter(isQaCustomerRecord);
  const qaCustomerIds = new Set(qaCustomers.map(row => String(row?.id || '').trim()).filter(Boolean));

  const scheduleRes = await api('/api/schedule');
  const scheduleItems = Array.isArray(scheduleRes.body) ? scheduleRes.body : [];
  const scheduleIds = scheduleItems
    .filter(row => isQaScheduleRecord(row, qaCustomerIds))
    .map(row => String(row?.id || '').trim())
    .filter(Boolean);

  const workItemsRes = await api('/api/workitems');
  const workItems = Array.isArray(workItemsRes.body) ? workItemsRes.body : [];
  const workItemIds = workItems
    .filter(row => isQaWorkItemRecord(row, qaCustomerIds))
    .map(row => String(row?.id || '').trim())
    .filter(Boolean);

  let scheduleDeleted = 0;
  for (const id of scheduleIds) {
    const result = await api(`/api/schedule/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (result.ok) scheduleDeleted += 1;
  }

  let workItemsDeleted = 0;
  for (const id of workItemIds) {
    const result = await api(`/api/workitems/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (result.ok) workItemsDeleted += 1;
  }

  let customersDeleted = 0;
  for (const row of qaCustomers) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    const result = await api('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ op: 'delete', id, tenantId })
    });
    if (result.ok) customersDeleted += 1;
  }

  console.log(
    `[qa] Purge complete for tenant "${tenantId}". ` +
    `Deleted ${scheduleDeleted}/${scheduleIds.length} schedule items, ` +
    `${workItemsDeleted}/${workItemIds.length} work items, ` +
    `${customersDeleted}/${qaCustomers.length} customers.`
  );
}

run().catch(err => {
  console.error(`[qa] Purge failed: ${String(err && err.message || err)}`);
  process.exit(1);
});
