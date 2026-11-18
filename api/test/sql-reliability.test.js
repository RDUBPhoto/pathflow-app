const test = require('node:test');
const assert = require('node:assert/strict');
const { _internals: i } = require('../_shared/table-client');

test('transient failures during initial pool acquisition are retried once', async () => {
  let calls = 0;
  const pool = {};
  assert.equal(await i.withRecoveredPool(async () => {
    if (++calls === 1) throw Object.assign(new Error('socket failed'), { code: 'ESOCKET' });
    return pool;
  }, async p => p), pool);
  assert.equal(calls, 2);
});

test('permanent SQL failures are not retried', async () => {
  let calls = 0;
  await assert.rejects(i.withRecoveredPool(async () => {
    calls++;
    throw new Error('Login failed');
  }, async () => {}), /Login failed/);
  assert.equal(calls, 1);
});

test('query failure evicts the old pool and reacquires a fresh one', async () => {
  const key = 'test-recovery';
  let closes = 0;
  const old = { __pathflowPoolKey: key, close: async () => { closes++; } };
  const fresh = {};
  i.poolByKey.set(key, Promise.resolve(old));
  let calls = 0;
  const result = await i.withRecoveredPool(async () => ++calls === 1 ? old : fresh, async p => {
    if (p === old) throw Object.assign(new Error('connection closed'), { code: 'ECONNCLOSED' });
    return p;
  });
  assert.equal(result, fresh);
  assert.equal(closes, 1);
  assert.equal(i.poolByKey.has(key), false);
});

test('a stale failure cannot close a concurrently replaced pool', async () => {
  const key = 'test-concurrent';
  let closes = 0;
  const old = { __pathflowPoolKey: key };
  const fresh = { close: async () => { closes++; } };
  i.poolByKey.set(key, Promise.resolve(fresh));
  let calls = 0;
  try {
    await i.withRecoveredPool(async () => ++calls === 1 ? old : fresh, async p => {
      if (p === old) throw Object.assign(new Error('closed'), { code: 'ECONNCLOSED' });
    });
    assert.equal(closes, 0);
    assert.equal(await i.poolByKey.get(key), fresh);
  } finally { i.poolByKey.delete(key); }
});

test('tenant and row filters become bound SQL parameters without rewriting keys', () => {
  const predicate = i.buildSqlKeyPredicate(i.parseFilter("PartitionKey eq 'Tenant:ABC' and RowKey eq 'x''; DROP TABLE t;--'"));
  assert.equal(predicate.clause, '(partition_key = @keyFilter0 AND row_key = @keyFilter1)');
  assert.deepEqual(predicate.parameters.map(p => p.value), ['Tenant:ABC', "x'; DROP TABLE t;--"]);
  assert.ok(!predicate.clause.includes('DROP'));
});

test('an OR with a non-key branch is not incorrectly narrowed to one tenant', () => {
  const predicate = i.buildSqlKeyPredicate(i.parseFilter("PartitionKey eq 'tenant-a' or status eq 'active'"));
  assert.equal(predicate.clause, '(partition_key = @keyFilter0 OR 1=1)');
});

test('merging after a failed existing-entity read does not overwrite data', async () => {
  const client = new i.SqlEntityTableClient('customers');
  let writes = 0;
  client.getEntity = async () => { throw new Error('timeout'); };
  client.resolvePoolForPartitionKey = async () => { writes++; throw new Error('unexpected write'); };
  await assert.rejects(client.upsertEntity({ partitionKey: 'tenant-a', rowKey: 'one', name: 'changed' }), /timeout/);
  assert.equal(writes, 0);
});

test('wrapped connection strings receive timeout defaults too', () => {
  const config = i.normalizeSqlPoolConfig({ connectionString: 'Server=localhost;Database=test;User Id=test;Password=fake;' });
  assert.equal(config.server, 'localhost');
  assert.equal(config.requestTimeout, 30000);
});

test('Azure database-resuming errors are retried', async () => {
  let calls = 0;
  const result = await i.withRecoveredPool(async () => {
    if (++calls === 1) throw Object.assign(new Error('Database unavailable'), { number: 40613 });
    return {};
  }, async () => 'ready');
  assert.equal(result, 'ready');
  assert.equal(calls, 2);
});

test('list queries use a fresh cached pool after failure and retain the SQL tenant predicate', async () => {
  const key = 'test-list-recovery';
  const config = { server: 'localhost', database: 'fake', user: 'fake', password: 'fake' };
  const requests = [];
  const fresh = {
    __pathflowPoolKey: key, config, connected: true,
    request() {
      const params = {};
      return {
        input(name, _type, value) { params[name] = value; return this; },
        async query(query) {
          requests.push({ query, params });
          return { recordset: query.includes('SELECT partition_key') ? [
            { partition_key: 'tenant-a', row_key: 'one', entity_json: '{}' },
            { partition_key: 'tenant-b', row_key: 'two', entity_json: '{}' }
          ] : [] };
        }
      };
    }
  };
  const old = {
    __pathflowPoolKey: key, config, connected: true,
    close: async () => { i.poolByKey.set(key, Promise.resolve(fresh)); },
    request() {
      return {
        input() { return this; },
        async query(query) {
          if (query.includes('SELECT partition_key')) throw Object.assign(new Error('socket reset'), { code: 'ESOCKET' });
          return { recordset: [] };
        }
      };
    }
  };
  const client = new i.SqlEntityTableClient('customers');
  client.resolvePoolsForList = async () => [old];
  i.poolByKey.set(key, Promise.resolve(old));
  try {
    const rows = [];
    for await (const row of client.listEntities({ filter: "PartitionKey eq 'tenant-a'" })) rows.push(row);
    assert.deepEqual(rows.map(row => row.rowKey), ['one']);
    const select = requests.find(r => r.query.includes('SELECT partition_key'));
    assert.match(select.query, /AND partition_key = @keyFilter0/);
    assert.equal(select.params.keyFilter0, 'tenant-a');
  } finally { i.poolByKey.delete(key); }
});
