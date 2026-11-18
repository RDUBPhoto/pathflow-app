const { checkSqlReadiness } = require('../_shared/table-client');

module.exports = async function (context) {
  const started = Date.now();
  try {
    await checkSqlReadiness();
    context.res = {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: { ok: true, database: 'ready', durationMs: Date.now() - started }
    };
  } catch (_) {
    // Do not disclose connection strings, infrastructure names, or SQL errors.
    context.res = {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' },
      body: { ok: false, database: 'unavailable' }
    };
  }
};
