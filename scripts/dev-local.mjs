import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const apiRoot = path.join(root, 'api');
const scriptPath = path.resolve(process.argv[1] || path.join(root, 'scripts', 'dev-local.mjs'));
const repoNode18Path = path.join(root, 'node_modules', 'node', 'bin', 'node');
const procs = [];
let shuttingDown = false;
const REQUIRED_NODE_MAJOR = 18;
const shouldSeedDemo =
  process.argv.includes('--seed-demo') ||
  process.env.PATHFLOW_SEED_DEMO === '1' ||
  String(process.env.PATHFLOW_SEED_DEMO || '').toLowerCase() === 'true';

function readLocalSettingsValues() {
  try {
    const raw = fs.readFileSync(path.join(root, 'api', 'local.settings.json'), 'utf8');
    const json = JSON.parse(raw);
    const values = json && typeof json === 'object' ? (json.Values || {}) : {};
    return values && typeof values === 'object' ? values : {};
  } catch {
    return {};
  }
}

function isPlaceholderKey(value) {
  const key = String(value || '').trim();
  if (!key) return true;
  if (key === 'REPLACE_WITH_DEV_SENDGRID_KEY') return true;
  if (key.startsWith('YOUR_')) return true;
  return false;
}

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  procs.push(p);
  p.on('exit', code => {
    if (!shuttingDown && code && code !== 0) {
      console.error(`[dev-local] ${cmd} exited with code ${code}`);
      shutdown(code);
    }
  });
  return p;
}

function nodeMajor(version = process.version) {
  const v = String(version || '').replace(/^v/, '');
  const parsed = Number.parseInt(v.split('.')[0], 10);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function assertFunctionsNodeVersion() {
  const major = nodeMajor();
  if (major === REQUIRED_NODE_MAJOR) return;

  // Re-run under the repo-managed Node 18 runtime when the global Node is incompatible.
  if (process.env.PATHFLOW_DEV_LOCAL_REEXEC !== '1' && fs.existsSync(repoNode18Path)) {
    const result = spawnSync(repoNode18Path, [scriptPath, ...process.argv.slice(2)], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        PATHFLOW_DEV_LOCAL_REEXEC: '1'
      }
    });
    process.exit(result.status ?? 1);
  }

  console.error(`[dev-local] Node ${process.version} is incompatible with Azure Functions worker in this repo.`);
  console.error(`[dev-local] Switch to Node ${REQUIRED_NODE_MAJOR} and run npm start again.`);
  console.error(`[dev-local] If you use nvm: nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}`);
  process.exit(1);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    try { p.kill('SIGINT'); } catch {}
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const localValues = readLocalSettingsValues();
const localEmailMode = String(localValues.EMAIL_MODE || '').trim().toLowerCase();
const localEmailFrom = String(localValues.EMAIL_FROM || '').trim();
const localSendgridKey = String(localValues.SENDGRID_API_KEY || '').trim();
if (localEmailMode === 'sendgrid') {
  if (isPlaceholderKey(localSendgridKey)) {
    console.warn('[dev-local] EMAIL_MODE=sendgrid but SENDGRID_API_KEY is missing/placeholder in api/local.settings.json');
    console.warn('[dev-local] Local email sends will not go live until SENDGRID_API_KEY is set.');
  }
  if (!localEmailFrom) {
    console.warn('[dev-local] EMAIL_MODE=sendgrid but EMAIL_FROM is empty in api/local.settings.json');
  }
}

assertFunctionsNodeVersion();
run('azurite', ['--location', '.azurite', '--debug', '.azurite/debug.log']);
run('func', ['start'], { cwd: apiRoot });

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPing(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://localhost:7071/api/ping');
      if (res.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function waitForFrontendApiProxy(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://localhost:4200/api/ping');
      if (res.ok) return true;
    } catch {}
    await sleep(800);
  }
  return false;
}

async function logEmailRuntimeStatus() {
  try {
    const res = await fetch('http://localhost:7071/api/email');
    if (!res.ok) {
      console.warn(`[dev-local] Could not read /api/email status (${res.status})`);
      return;
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      console.warn('[dev-local] /api/email returned a non-JSON status payload');
      return;
    }
    const mode = String(body.mode || 'unknown');
    const ready = !!body.readyForLive;
    const fromEmail = String(body.fromEmail || '');
    const provider = String(body.provider || '');
    console.log(`[dev-local] Email runtime: mode=${mode} provider=${provider} readyForLive=${ready} from=${fromEmail || '(empty)'}`);
  } catch {
    console.warn('[dev-local] Could not read /api/email runtime status');
  }
}

async function seedIfEmpty() {
  try {
    const res = await fetch('http://localhost:7071/api/customers');
    if (res.ok) {
      const body = await res.json().catch(() => []);
      const list = Array.isArray(body) ? body : (Array.isArray(body?.value) ? body.value : []);
      if (list.length > 0) return;
    }
  } catch {}

  const post = async (url, payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Seed failed ${url} ${res.status}`);
    return res.json().catch(() => ({}));
  };

  const lanes = [
    'Leads',
    'Scheduled',
    'In Progress',
    'Completed'
  ];
  const laneIds = {};
  for (const name of lanes) {
    const r = await post('http://localhost:7071/api/lanes', { name });
    if (r?.id) laneIds[name] = r.id;
  }

  const customers = [
    { name: 'Jordan Miles', phone: '(555) 201-8841', email: 'jordan@example.com', vehicleYear: '2019', vehicleMake: 'Jeep', vehicleModel: 'Wrangler', vehicleColor: '#1976d2', notes: 'Wants matte wrap.' },
    { name: 'Avery Chen', phone: '(555) 991-1223', email: 'avery@example.com', vehicleYear: '2021', vehicleMake: 'Ford', vehicleModel: 'Bronco', vehicleColor: '#f57c00', notes: 'Install rock sliders.' },
    { name: 'Sam Patel', phone: '(555) 303-4422', email: 'sam@example.com', vehicleYear: '2017', vehicleMake: 'Toyota', vehicleModel: '4Runner', vehicleColor: '#388e3c', notes: 'Full detail + ceramic.' },
    { name: 'Morgan Lee', phone: '(555) 771-9001', email: 'morgan@example.com', vehicleYear: '2020', vehicleMake: 'Tacoma', vehicleModel: 'TRD', vehicleColor: '#808080', notes: 'Bed rack quote.' },
    { name: 'Riley Jones', phone: '(555) 115-6600', email: 'riley@example.com', vehicleYear: '2018', vehicleMake: 'F-150', vehicleModel: 'Lariat', vehicleColor: '#000000', notes: 'LED light bar.' },
    { name: 'Casey Nguyen', phone: '(555) 884-2100', email: 'casey@example.com', vehicleYear: '2022', vehicleMake: 'Gladiator', vehicleModel: 'Rubicon', vehicleColor: '#d32f2f', notes: 'Bumper install.' }
  ];

  const customerIds = [];
  for (const c of customers) {
    const r = await post('http://localhost:7071/api/customers', { ...c, createdAt: new Date().toISOString() });
    if (r?.id) customerIds.push(r.id);
  }

  const items = [
    { title: 'Jordan Miles (2019 Jeep Wrangler) — Matte wrap', lane: 'Leads', customerIndex: 0 },
    { title: 'Avery Chen (2021 Ford Bronco) — Rock sliders', lane: 'Scheduled', customerIndex: 1 },
    { title: 'Sam Patel (2017 Toyota 4Runner) — Ceramic coat', lane: 'In Progress', customerIndex: 2 },
    { title: 'Morgan Lee (2020 Tacoma TRD) — Bed rack quote', lane: 'Leads', customerIndex: 3 },
    { title: 'Riley Jones (2018 F-150 Lariat) — LED light bar', lane: 'Scheduled', customerIndex: 4 },
    { title: 'Casey Nguyen (2022 Gladiator Rubicon) — Bumper install', lane: 'Completed', customerIndex: 5 }
  ];

  for (const it of items) {
    const laneId = laneIds[it.lane] || Object.values(laneIds)[0];
    if (!laneId) continue;
    const r = await post('http://localhost:7071/api/workitems', { title: it.title, laneId });
    const custId = customerIds[it.customerIndex];
    if (r?.id && custId) {
      await post('http://localhost:7071/api/workitems', { id: r.id, customerId: custId });
    }
  }

  try {
    const res = await fetch('http://localhost:7071/api/schedule');
    if (res.ok) {
      const body = await res.json().catch(() => []);
      if (Array.isArray(body) && body.length > 0) return;
    }
  } catch {}

  const today = new Date();
  today.setHours(7, 0, 0, 0);
  const slot = (h) => {
    const d = new Date(today.getTime());
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };

  const sched = [
    {
      customerIndex: 0,
      resource: 'bay-1',
      start: slot(7),
      end: slot(11),
      partRequests: [
        { partName: 'Front Brake Pad Set', qty: 1, vendorHint: 'NAPA', sku: 'BP-F150-2018' }
      ]
    },
    {
      customerIndex: 1,
      resource: 'bay-2',
      start: slot(8),
      end: slot(12),
      partRequests: [
        { partName: 'Rock Slider Hardware Kit', qty: 1, vendorHint: "O'Reilly", sku: 'RS-HW-BRONCO' }
      ]
    },
    {
      customerIndex: 2,
      resource: 'bay-3',
      start: slot(9),
      end: slot(13),
      partRequests: [
        { partName: 'Spark Plug Set', qty: 1, vendorHint: 'AutoZone', sku: 'SP-TOY-4RUN' }
      ]
    },
    { customerIndex: 3, resource: 'bay-4', start: slot(10), end: slot(14), partRequests: [] },
    { customerIndex: 4, resource: 'bay-5', start: slot(11), end: slot(15), partRequests: [] }
  ];

  for (const s of sched) {
    const customerId = customerIds[s.customerIndex];
    await post('http://localhost:7071/api/schedule', {
      start: s.start,
      end: s.end,
        resource: s.resource,
        customerId,
        isBlocked: false,
        title: '',
        notes: '',
        partRequests: s.partRequests || []
      });
  }

  try {
    const invRes = await fetch('http://localhost:7071/api/inventory?scope=items');
    if (invRes.ok) {
      const invBody = await invRes.json().catch(() => ({}));
      const items = Array.isArray(invBody?.items) ? invBody.items : [];
      if (!items.length) {
        const seedInventory = [
          { name: 'Brake Pad Set - Front', sku: 'BP-F150-2018', vendor: 'NAPA', category: 'Brakes', onHand: 2, reorderAt: 4, onOrder: 0, unitCost: 74.5 },
          { name: 'Oil Filter', sku: 'OF-5W20-FLT', vendor: "O'Reilly", category: 'Maintenance', onHand: 10, reorderAt: 8, onOrder: 0, unitCost: 6.2 },
          { name: 'Spark Plug Set', sku: 'SP-TOY-4RUN', vendor: 'AutoZone', category: 'Ignition', onHand: 2, reorderAt: 6, onOrder: 0, unitCost: 42.0 }
        ];
        for (const item of seedInventory) {
          await post('http://localhost:7071/api/inventory', { op: 'upsertItem', ...item });
        }
      }
    }
  } catch {}
}

(async () => {
  const ok = await waitForPing();
  if (ok) {
    await logEmailRuntimeStatus();
    if (shouldSeedDemo) {
      try { await seedIfEmpty(); } catch (e) { console.error('[dev-local] seed error', e?.message || e); }
    } else {
      console.log('[dev-local] Demo seed skipped (pass --seed-demo or PATHFLOW_SEED_DEMO=1 to enable)');
    }
  } else {
    console.error('[dev-local] API did not start in time');
  }
  run('ng', ['serve', '--no-hmr', '--proxy-config', 'proxy.conf.local.json', '--port', '4200', '--host', 'localhost']);

  const proxyOk = await waitForFrontendApiProxy();
  if (proxyOk) {
    console.log('[dev-local] Frontend proxy ready: http://localhost:4200/api -> http://localhost:7071/api');
  } else {
    console.error('[dev-local] Frontend started but /api proxy check failed at http://localhost:4200/api/ping');
    console.error('[dev-local] If you see /api 404s, stop all dev servers and run `npm start` again from this folder.');
  }
})();
