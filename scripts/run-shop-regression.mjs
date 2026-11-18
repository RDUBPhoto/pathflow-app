import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const repo = process.cwd();
const scratch = mkdtempSync(path.join(tmpdir(), 'pathflow-shop-regression-'));
const functionRoot = path.join(scratch, 'api');
const storageRoot = path.join(scratch, 'storage');
const functionsUrl = 'http://127.0.0.1:7071';
const frontendUrl = 'http://localhost:4200';
const runtimeEnvironment = { PATH: process.env.PATH, NODE_ENV: 'development', PATHFLOW_ENVIRONMENT: 'development' };
const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  const done = new Promise(resolve => {
    child.once('exit', code => resolve(code ?? 1));
    child.once('error', error => {
      console.error(error.message);
      resolve(1);
    });
  });
  children.push({ child, done });
  return { child, done };
}

async function waitFor(url, child, anyResponse = false) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && child.pid) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok || anyResponse) return;
    } catch {}
    await wait(250);
  }
  throw new Error(`Isolated service did not start at ${url}`);
}

async function stop() {
  for (const { child } of [...children].reverse()) child.kill('SIGINT');
  await Promise.race([Promise.all(children.map(({ done }) => done)), wait(3000)]);
  rmSync(scratch, { recursive: true, force: true });
}

async function portMustBeFree(url) {
  let answered = false;
  try {
    await fetch(url, { signal: AbortSignal.timeout(600) });
    answered = true;
  } catch {}
  if (answered) throw new Error(`Stop the existing service at ${url} before running isolated shop tests.`);
}

try {
  await Promise.all([functionsUrl, frontendUrl, ...[10000, 10001, 10002].map(port => `http://127.0.0.1:${port}`)].map(portMustBeFree));
  cpSync(path.join(repo, 'api'), functionRoot, {
    recursive: true,
    filter: name => !/^(node_modules|local\.settings.*|\.env.*|test)$/.test(path.basename(name))
  });
  symlinkSync(path.join(repo, 'api', 'node_modules'), path.join(functionRoot, 'node_modules'), 'dir');
  mkdirSync(storageRoot);
  writeFileSync(path.join(functionRoot, 'local.settings.json'), JSON.stringify({
    IsEncrypted: false,
    Values: {
      AzureWebJobsStorage: 'UseDevelopmentStorage=true',
      STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
      FUNCTIONS_WORKER_RUNTIME: 'node',
      DATA_BACKEND: 'table',
      PATHFLOW_ENVIRONMENT: 'development',
      EMAIL_MODE: 'mock',
      SMS_MODE: 'mock',
      DEFAULT_TENANT_ID: 'primary-location',
      APP_BASE_URL: frontendUrl
    }
  }));
  const storage = run('azurite', ['--silent', '--location', storageRoot], { env: runtimeEnvironment });
  await waitFor('http://127.0.0.1:10002/', storage.child, true);
  const functions = run('func', ['start', '--port', '7071'], { cwd: functionRoot, env: runtimeEnvironment });
  await waitFor(`${functionsUrl}/api/ping`, functions.child);
  const apiTests = run(process.execPath, ['--test', 'api/test/inventory-workflow.test.js'], {
    env: { ...runtimeEnvironment, PATHFLOW_WORKFLOW_QA_BASE_URL: functionsUrl }
  });
  if (await apiTests.done) throw new Error('Isolated API workflow failed.');

  const node = process.execPath;
  const frontend = run(node, ['node_modules/@angular/cli/bin/ng.js', 'serve', '--no-hmr',
    '--proxy-config', 'proxy.conf.local.json', '--port', '4200', '--host', '127.0.0.1'], { env: runtimeEnvironment });
  await waitFor(`${frontendUrl}/api/ping`, frontend.child);
  const browser = run(node, ['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.shop.config.ts'], {
    env: { ...runtimeEnvironment, PATHFLOW_SHOP_TEST_OUTPUT: path.join(repo, 'test-results', 'shop-regression') }
  });
  if (await browser.done) throw new Error('Isolated browser workflow failed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop();
}
