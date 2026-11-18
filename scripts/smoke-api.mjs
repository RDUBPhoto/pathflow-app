// Read-only release gate. A successful SPA fallback is not a healthy API.
const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/smoke-api.mjs https://candidate-host');
const base = new URL(target);
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
  throw new Error('Remote smoke checks require HTTPS.');
}
for (const endpoint of ['/api/ping', '/api/ready']) {
  const started = performance.now();
  const response = await fetch(new URL(endpoint, base), {
    signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  if (response.status !== 200) throw new Error(`${endpoint}: HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`${endpoint}: expected JSON, not a frontend fallback`);
  }
  const body = await response.json();
  if (body.ok !== true) throw new Error(`${endpoint}: API did not report success`);
  if (endpoint === '/api/ready' && body.database !== 'ready') {
    throw new Error('Database readiness not confirmed');
  }
  console.log(`${endpoint}: PASS (${Math.round(performance.now() - started)} ms)`);
}
