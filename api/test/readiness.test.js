const test = require('node:test');
const assert = require('node:assert/strict');

async function withReadiness(check, run) {
  const shared = require('../_shared/table-client');
  const original = shared.checkSqlReadiness;
  const handlerPath = require.resolve('../ready');
  shared.checkSqlReadiness = check;
  delete require.cache[handlerPath];
  try { await run(require('../ready')); }
  finally {
    shared.checkSqlReadiness = original;
    delete require.cache[handlerPath];
  }
}

test('readiness reports success only after the database check finishes', async () => {
  let checked = false;
  await withReadiness(async () => { checked = true; }, async handler => {
    const context = {};
    await handler(context);
    assert.equal(checked, true);
    assert.equal(context.res.status, 200);
    assert.equal(context.res.body.database, 'ready');
    assert.equal(context.res.headers['cache-control'], 'no-store');
  });
});

test('failed database readiness returns retryable 503 without exposing secrets', async () => {
  await withReadiness(async () => { throw new Error('Password=DO-NOT-EXPOSE'); }, async handler => {
    const context = {};
    await handler(context);
    assert.equal(context.res.status, 503);
    assert.equal(context.res.body.ok, false);
    assert.equal(context.res.headers['retry-after'], '5');
    assert.doesNotMatch(JSON.stringify(context.res), /DO-NOT-EXPOSE/);
  });
});
