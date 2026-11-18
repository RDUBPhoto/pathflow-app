import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const repo = process.cwd();
const build = path.join(repo, 'dist/web/browser');
const scratch = mkdtempSync(path.join(tmpdir(), 'pathflow-production-auth-'));
const api = path.join(scratch, 'api');
const frontendUrl = 'https://localhost:14443';
const functionsUrl = 'http://127.0.0.1:17771';
const children = [];
let web;

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  const done = new Promise(resolve => {
    child.once('exit', code => resolve(code ?? 1));
    child.once('error', error => { console.error(error.message); resolve(1); });
  });
  children.push({ child, done });
  return { child, done };
}

async function requireFreePort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  await new Promise(resolve => server.close(resolve));
}

async function ready(url, process) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && process.exitCode === null && process.signalCode === null) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch {}
    await wait(250);
  }
  throw new Error('Isolated production-auth service did not start.');
}

async function stop() {
  if (web) await new Promise(resolve => web.close(resolve));
  for (const { child } of [...children].reverse()) child.kill('SIGINT');
  await Promise.race([Promise.all(children.map(({ done }) => done)), wait(3000)]);
  rmSync(scratch, { recursive: true, force: true });
}

try {
  if (!existsSync(path.join(build, 'index.html'))) throw new Error('Build the production frontend before running this regression.');
  await Promise.all([14443, 17771, 12000, 12001, 12002].map(requireFreePort));
  cpSync(path.join(repo, 'api'), api, {
    recursive: true,
    filter: filename => !/^(node_modules|local\.settings.*|\.env.*|test)$/.test(path.basename(filename))
  });
  symlinkSync(path.join(repo, 'api/node_modules'), path.join(api, 'node_modules'), 'dir');
  mkdirSync(path.join(scratch, 'storage'));
  const cert = path.join(scratch, 'localhost.pem');
  const key = path.join(scratch, 'localhost-key.pem');
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const account = 'releaseauth';
  const accountKey = randomBytes(48).toString('base64');
  const connection = [
    'DefaultEndpointsProtocol=https', 'AccountName=' + account, 'AccountKey=' + accountKey,
    'BlobEndpoint=https://127.0.0.1:12000/' + account,
    'QueueEndpoint=https://127.0.0.1:12001/' + account,
    'TableEndpoint=https://127.0.0.1:12002/' + account
  ].join(';');
  // Only disposable emulator credentials and mocked integrations enter the host.
  const environment = {
    PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
    NODE_ENV: 'production', PATHFLOW_ENVIRONMENT: 'production',
    NODE_EXTRA_CA_CERTS: cert
  };
  writeFileSync(path.join(api, 'local.settings.json'), JSON.stringify({ IsEncrypted: false, Values: {
    AzureWebJobsStorage: connection, STORAGE_CONNECTION_STRING: connection,
    FUNCTIONS_WORKER_RUNTIME: 'node', DATA_BACKEND: 'table',
    WEBSITE_SITE_NAME: 'isolated-release-auth', PATHFLOW_ENVIRONMENT: 'production', NODE_ENV: 'production',
    EMAIL_MODE: 'mock', SMS_MODE: 'mock', AUTH_PRIMARY_PROVIDER: 'local', AUTH_LOCAL_PASSWORD_ENABLED: 'true',
    APP_BASE_URL: frontendUrl, PASSKEY_RP_ID: 'localhost', DEFAULT_TENANT_ID: 'primary-location'
  } }), { mode: 0o600 });
  const storage = run('azurite', ['--silent', '--location', path.join(scratch, 'storage'),
    '--blobPort', '12000', '--queuePort', '12001', '--tablePort', '12002', '--cert', cert, '--key', key], {
    env: { ...environment, AZURITE_ACCOUNTS: account + ':' + accountKey }
  });
  await wait(1500);
  if (storage.child.exitCode !== null) throw new Error('Disposable storage could not start.');
  const functions = run('func', ['start', '--port', '17771'], { cwd: api, env: environment });
  await ready(functionsUrl + '/api/ping', functions.child);

  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  web = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const url = new URL(req.url, frontendUrl);
    if (url.pathname.startsWith('/api/')) {
      const proxy = http.request(functionsUrl + req.url, { method: req.method,
        headers: { ...req.headers, host: 'localhost:14443', 'x-forwarded-proto': 'https' } }, reply => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      proxy.once('error', () => { res.writeHead(502); res.end(); });
      req.pipe(proxy);
      return;
    }
    let filename = path.resolve(build, '.' + url.pathname);
    if (!filename.startsWith(build + path.sep)) filename = path.join(build, 'index.html');
    if (!existsSync(filename) || !statSync(filename).isFile()) filename = path.join(build, 'index.html');
    res.setHeader('content-type', mime[path.extname(filename)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    createReadStream(filename).pipe(res);
  });
  await new Promise((resolve, reject) => { web.once('error', reject); web.listen(14443, resolve); });
  const browser = run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.production.config.ts'], {
    env: { ...environment, PATHFLOW_PRODUCTION_TEST_OUTPUT: path.join(repo, 'test-results/production-auth') }
  });
  if (await browser.done) throw new Error('Production auth regression failed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop();
}
