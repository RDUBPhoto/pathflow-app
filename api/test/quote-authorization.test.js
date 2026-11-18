const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { TableClient } = require('../_shared/table-client');
const { scopedTenantPartition } = require('../_shared/notification-partition');

async function fixture(run) {
  const original = TableClient.fromConnectionString;
  const previousStorage = process.env.STORAGE_CONNECTION_STRING;
  const previousSite = process.env.WEBSITE_SITE_NAME;
  process.env.STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
  process.env.WEBSITE_SITE_NAME = 'hosted-test';
  const tables = new Map();
  const rows = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const put = (name, row) => rows(name).set(`${row.partitionKey}|${row.rowKey}`, row);
  put('authsessions', {
    partitionKey: 'v1', rowKey: crypto.createHash('sha256').update('valid-session').digest('hex'),
    userId: 'staff', email: 'staff@example.test', rolesJson: '["authenticated"]',
    expiresAt: new Date(Date.now() + 60000).toISOString(), revoked: false
  });
  const staff = { partitionKey: 'v1', rowKey: 'staff@example.test', userId: 'staff', email: 'staff@example.test',
    status: 'active', locationIdsJson: '["tenant-a"]' };
  put('useraccess', staff);
  const quote = { partitionKey: 'tenant-a', rowKey: 'quote-a', publicToken: 'secret-a', quoteNumber: 'Q-A',
    customerName: 'Real Customer', vehicle: 'Real Vehicle', businessName: 'Shop', quoteDataJson: '{}' };
  put('quoteresponses', quote);
  TableClient.fromConnectionString = (_, name) => ({
    async createTable() {},
    async createEntity(entity) {
      if (rows(name).has(`${entity.partitionKey}|${entity.rowKey}`)) throw Object.assign(new Error('Exists'), { statusCode: 409 });
      put(name, { ...entity });
    },
    async getEntity(pk, rk) {
      const entity = rows(name).get(`${pk}|${rk}`);
      if (!entity) throw Object.assign(new Error('Not found'), { statusCode: 404 });
      return { ...entity };
    },
    async upsertEntity(entity) { put(name, { ...(rows(name).get(`${entity.partitionKey}|${entity.rowKey}`) || {}), ...entity }); },
    async *listEntities() { yield* rows(name).values(); }
  });
  delete require.cache[require.resolve('../quote-response')];
  const handler = require('../quote-response');
  const request = async (options = {}) => {
    const context = {};
    await handler(context, { method: 'POST', ...options,
      headers: { host: 'app.example.test', 'x-tenant-id': 'tenant-a', ...options.headers } });
    return context.res;
  };
  try { await run({ request, rows, staff, quote }); }
  finally {
    TableClient.fromConnectionString = original;
    if (previousStorage === undefined) delete process.env.STORAGE_CONNECTION_STRING; else process.env.STORAGE_CONNECTION_STRING = previousStorage;
    if (previousSite === undefined) delete process.env.WEBSITE_SITE_NAME; else process.env.WEBSITE_SITE_NAME = previousSite;
    delete require.cache[require.resolve('../quote-response')];
  }
}

test('forged identity fields, principal headers and localhost forwarding cannot authorize quote publishing', () => fixture(async ({request, rows}) => {
  const res = await request({ headers: { 'x-user-email': 'staff@example.test', 'x-forwarded-host': 'localhost:7071',
    'x-dev-user-email': 'staff@example.test', 'x-ms-client-principal': Buffer.from(JSON.stringify({userId:'staff',userDetails:'staff@example.test'})).toString('base64') },
    body: { op:'publish-snapshot', quoteId:'new', publicToken:'token', actorEmail:'staff@example.test', userId:'staff' } });
  assert.equal(res.status, 401);
  assert.equal(rows('quoteresponses').size, 1);
}));

test('staff publishing and listing require a valid session and current tenant membership', () => fixture(async ({request, staff}) => {
  const body = { op:'publish-snapshot', quoteId:'new', publicToken:'token', quoteData:{} };
  assert.equal((await request({body, headers:{cookie:'pf_session=invalid'}})).status, 401);
  assert.equal((await request({body, headers:{cookie:'pf_session=valid-session','x-tenant-id':'tenant-b'}})).status, 403);
  assert.equal((await request({body, headers:{cookie:'pf_session=valid-session'}})).status, 200);
  assert.equal((await request({method:'GET', headers:{cookie:'pf_session=valid-session'}})).status, 200);
  staff.accessRevoked = true;
  assert.equal((await request({body, headers:{cookie:'pf_session=valid-session'}})).status, 403);
}));

test('missing, incorrect, cross-quote and cross-tenant public tokens cannot mutate quotes', () => fixture(async ({request, rows}) => {
  for (const body of [
    {quoteId:'quote-a', action:'accept'},
    {quoteId:'quote-a', action:'decline', publicToken:'wrong'},
    {quoteId:'quote-b', action:'accept', publicToken:'secret-a'}
  ]) assert.equal((await request({body})).status, 404);
  assert.equal((await request({headers:{'x-tenant-id':'tenant-b'},body:{quoteId:'quote-a',action:'accept',publicToken:'secret-a'}})).status,404);
  assert.equal(rows('quoteresponses').get('tenant-a|quote-a').stage, undefined);
  assert.equal(rows('notifications').size, 0);
}));

test('valid anonymous token accepts and declines only its quote using stored customer details', () => fixture(async ({request, rows}) => {
  for (const action of ['accept', 'decline']) {
    const res = await request({body:{quoteId:'quote-a',action,publicToken:'secret-a',customerName:'Forged',quoteNumber:'Fake'}});
    assert.equal(res.status,200);
    assert.equal(res.body.stage,action === 'accept' ? 'accepted' : 'declined');
    assert.equal(rows('quoteresponses').get('tenant-a|quote-a').customerName,'Real Customer');
  }
  for (const row of rows('notifications').values()) assert.doesNotMatch(row.message, /Forged|Fake/);
}));

test('quote alerts use the staff notification partition and a retry preserves the read state', () => fixture(async ({request, rows}) => {
  const body = { quoteId: 'quote-a', action: 'accept', publicToken: 'secret-a' };
  assert.equal((await request({body})).body.notificationsCreated, 1);
  const [notification] = rows('notifications').values();
  assert.equal(notification.partitionKey, scopedTenantPartition('tenant-a'));
  notification.read = true;
  notification.readAt = '2026-11-10T12:00:00Z';
  assert.equal((await request({body})).body.notificationsCreated, 0);
  assert.equal(rows('notifications').size, 1);
  assert.equal([...rows('notifications').values()][0].readAt, notification.readAt);
}));

test('public token cannot enumerate quotes and only reads the matching snapshot', () => fixture(async ({request}) => {
  assert.equal((await request({method:'GET',query:{publicToken:'anything'}})).status,400);
  assert.equal((await request({method:'GET',query:{quoteId:'quote-a',publicToken:'wrong'}})).status,404);
  const res = await request({method:'GET',query:{quoteId:'quote-a',publicToken:'secret-a'}});
  assert.equal(res.status,200);
  assert.equal(res.headers['cache-control'],'no-store');
}));
