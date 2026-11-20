const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { TableClient } = require('../_shared/table-client');
const { scopedTenantPartition } = require('../_shared/notification-partition');

async function fixture(run) {
  const original = TableClient.fromConnectionString;
  const previous = { storage: process.env.STORAGE_CONNECTION_STRING, site: process.env.WEBSITE_SITE_NAME };
  process.env.STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
  process.env.WEBSITE_SITE_NAME = 'hosted-notification-fixture';
  const tables = new Map();
  const rows = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const put = (name, row) => rows(name).set(`${row.partitionKey}|${row.rowKey}`, row);
  put('authsessions', { partitionKey: 'v1', rowKey: createHash('sha256').update('notification-session').digest('hex'),
    userId: 'staff-a', email: 'a@example.test', expiresAt: new Date(Date.now() + 60000).toISOString() });
  put('useraccess', { partitionKey: 'v1', rowKey: 'a@example.test', userId: 'staff-a', email: 'a@example.test',
    status: 'active', locationIdsJson: '["shop-a"]', rolesJson: '["authenticated","admin"]' });
  TableClient.fromConnectionString = (_, name) => ({
    async createTable() {},
    async getEntity(pk, rk) { const row = rows(name).get(`${pk}|${rk}`); if (!row) throw Object.assign(new Error('Missing'), { statusCode: 404 }); return { ...row }; },
    async upsertEntity(row) { put(name, { ...rows(name).get(`${row.partitionKey}|${row.rowKey}`), ...row }); },
    async *listEntities(options) {
      const filter = options?.queryOptions?.filter || '';
      const partition = filter.match(/PartitionKey eq '([^']+)'/)?.[1];
      for (const row of rows(name).values()) {
        if (partition && row.partitionKey !== partition) continue;
        if (filter.includes('read eq false') && row.read) continue;
        // Deliberately leave recipient filtering to the handler's explicit ownership check.
        yield { ...row };
      }
    }
  });
  delete require.cache[require.resolve('../notifications')];
  const handler = require('../notifications');
  const request = async (body, tenant = 'shop-a', authenticated = true) => {
    const context = { log: { error() {} } };
    await handler(context, { method: 'POST', headers: { host: 'app.example.test', 'x-tenant-id': tenant,
      ...(authenticated ? { cookie: 'pf_session=notification-session' } : {}) }, body });
    return context.res;
  };
  function add(id, overrides = {}) {
    const row = { partitionKey: scopedTenantPartition('shop-a'), tenantId: 'shop-a', rowKey: id,
      entityType: 'invoice', entityId: 'invoice-1', route: '/invoices/invoice-1', title: 'Invoice paid',
      metadataJson: JSON.stringify({ invoiceId: 'invoice-1', customerId: 'customer-a', customerName: 'Same Customer' }),
      targetUserId: 'staff-a', targetEmail: 'a@example.test', read: false, readAt: '', createdAt: new Date().toISOString(), ...overrides };
    put('notifications', row); return row;
  }
  try { await run({ request, add, rows }); }
  finally { TableClient.fromConnectionString = original;
    if (previous.storage === undefined) delete process.env.STORAGE_CONNECTION_STRING; else process.env.STORAGE_CONNECTION_STRING = previous.storage;
    if (previous.site === undefined) delete process.env.WEBSITE_SITE_NAME; else process.env.WEBSITE_SITE_NAME = previous.site;
  }
}

const invoice = { type: 'invoice', id: 'invoice-1', number: 'INV-1' };

test('view acknowledgement targets the exact invoice and current recipient, including old notifications beyond the first page', () => fixture(async ({ request, add, rows }) => {
  for (let i = 0; i < 125; i++) add('related-' + i);
  add('other-job', { entityId: 'invoice-10', route: '/invoices/invoice-10', metadataJson: JSON.stringify({ invoiceId: 'invoice-10', customerId: 'customer-a', customerName: 'Same Customer' }) });
  add('other-user', { targetUserId: 'staff-b', targetEmail: 'b@example.test' });
  add('other-tenant', { tenantId: 'shop-b', partitionKey: scopedTenantPartition('shop-b') });
  add('quote-same-key', { entityType: 'quote', route: '/quotes/invoice-1', metadataJson: JSON.stringify({ documentId: 'invoice-1', documentType: 'quote' }) });
  const response = await request({ op: 'markRelatedRead', contexts: [invoice], actorUserId: 'staff-b', actorEmail: 'b@example.test' });
  assert.equal(response.status, 200);
  assert.equal(response.body.updated, 125);
  for (const row of rows('notifications').values()) assert.equal(row.read, row.rowKey.startsWith('related-'), row.rowKey);
}));

test('reading is idempotent and later events remain unread', () => fixture(async ({ request, add, rows }) => {
  add('initial');
  assert.equal((await request({ op: 'markRelatedRead', contexts: [invoice] })).body.updated, 1);
  const originalReadAt = [...rows('notifications').values()][0].readAt;
  assert.equal((await request({ op: 'markRelatedRead', contexts: [invoice] })).body.updated, 0);
  assert.equal([...rows('notifications').values()][0].readAt, originalReadAt);
  const later = add('final-payment');
  assert.equal(later.read, false);
}));

test('profile views acknowledge customer intake, not unread invoices or messages', () => fixture(async ({ request, add, rows }) => {
  add('paid');
  add('lead', { entityType: 'lead', entityId: 'lead-1', route: '/customers/customer-a', metadataJson: '{"customerId":"customer-a","leadItemId":"lead-1"}' });
  add('email', { entityType: 'email', entityId: 'message-1', metadataJson: '{"customerId":"customer-a"}' });
  const response = await request({ op: 'markRelatedRead', contexts: [{ type: 'customer', id: 'customer-a' }] });
  assert.equal(response.body.updated, 1);
  assert.deepEqual([...rows('notifications').values()].filter(row => row.read).map(row => row.rowKey), ['lead']);
}));

test('exact routes and legacy numbers are supported without matching another explicit invoice ID', () => fixture(async ({ request, add, rows }) => {
  add('route-only', { entityType: 'item', entityId: '', route: '/invoices/invoice-1', metadataJson: '{}' });
  add('number-only', { entityType: 'item', entityId: '', route: '/dashboard', metadataJson: '{"invoiceNumber":"INV-1"}' });
  add('wrong-id', { entityId: 'invoice-2', metadataJson: '{"invoiceId":"invoice-2","invoiceNumber":"INV-1"}' });
  const response = await request({ op: 'markRelatedRead', contexts: [invoice] });
  assert.equal(response.body.updated, 2);
  assert.equal([...rows('notifications').values()].find(row => row.rowKey === 'wrong-id').read, false);
}));

test('view acknowledgement requires a session, tenant access and valid contexts', () => fixture(async ({ request, add }) => {
  add('paid');
  assert.equal((await request({ op: 'markRelatedRead', contexts: [invoice] }, 'shop-a', false)).status, 401);
  assert.equal((await request({ op: 'markRelatedRead', contexts: [invoice] }, 'shop-b')).status, 403);
  for (const contexts of [[], [{ type: 'all', id: '*' }], Array(21).fill(invoice)]) {
    assert.equal((await request({ op: 'markRelatedRead', contexts })).status, 400);
  }
}));
