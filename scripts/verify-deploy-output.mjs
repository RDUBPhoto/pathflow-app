import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const candidateRoots = [path.join(root, 'dist', 'web', 'browser'), path.join(root, 'dist', 'web')];
const outputRoot = candidateRoots.find(candidate => fs.existsSync(path.join(candidate, 'index.html')));

function fail(message) {
  console.error(`[verify-deploy-output] ${message}`);
  process.exitCode = 1;
}

if (!outputRoot) {
  fail('Angular build output is missing index.html. Run npm run build first.');
} else {
  const indexPath = path.join(outputRoot, 'index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  if (!fs.existsSync(path.join(outputRoot, 'asset-recovery.js')) || !indexHtml.includes('src="/asset-recovery.js"')) {
    fail('Early asset recovery script is missing from the deploy output.');
  }
  if (!/main-[A-Z0-9_-]+\.js/i.test(indexHtml)) fail('index.html does not reference a hashed production main bundle.');
  const configPath = path.join(outputRoot, 'staticwebapp.config.json');
  if (!fs.existsSync(configPath)) {
    fail('staticwebapp.config.json is missing from the deploy output.');
  } else if (JSON.parse(fs.readFileSync(configPath, 'utf8')).platform?.apiRuntime !== 'node:22') {
    fail('Static Web Apps must use the same Node 22 runtime as release validation.');
  }

  const jsFiles = fs.readdirSync(outputRoot).filter(name => name.endsWith('.js'));
  for (const file of jsFiles) {
    const contents = fs.readFileSync(path.join(outputRoot, file), 'utf8');
    if (/http:\/\/(?:localhost|127\.0\.0\.1):(?:4200|7071)/.test(contents)) {
      fail(`${file} contains a localhost API URL.`);
      break;
    }
  }
}

for (const functionName of ['access', 'ping', 'ready', 'telemetry', 'widget-lead', 'service-documents', 'customer-portal', 'payment-charge']) {
  for (const fileName of ['function.json', 'index.js']) {
    const target = path.join(root, 'api', functionName, fileName);
    if (!fs.existsSync(target)) fail(`Required API artifact is missing: api/${functionName}/${fileName}`);
  }
}

if (!process.exitCode) console.log('[verify-deploy-output] deploy artifacts look complete.');
