import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const qaDir = path.join(root, 'qa-reports');
fs.mkdirSync(qaDir, { recursive: true });

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');

function asText(value) {
  return value == null ? '' : String(value).trim();
}

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

function resolveRecipientList(raw) {
  return String(raw || '')
    .split(/[,\s;]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function runAndCapture(name, command, args) {
  fs.mkdirSync(qaDir, { recursive: true });
  const startedAt = new Date();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
    shell: process.platform === 'win32'
  });
  const endedAt = new Date();
  const logPath = path.join(qaDir, `${stamp}-${name}.log`);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, output, 'utf8');

  return {
    name,
    ok: result.status === 0,
    code: result.status ?? 1,
    startedAt,
    endedAt,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    logPath
  };
}

function readCoverageSummary() {
  const summaryPath = path.join(root, 'coverage', 'web', 'coverage-summary.json');
  if (!fs.existsSync(summaryPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    return parsed?.total || null;
  } catch {
    return null;
  }
}

async function sendQaEmailReport({ checks, reportPath, now }) {
  const localValues = readLocalSettingsValues();
  const sendgridApiKey = asText(process.env.SENDGRID_API_KEY || localValues.SENDGRID_API_KEY);
  const fromEmail = asText(
    process.env.QA_REPORT_EMAIL_FROM
    || process.env.EMAIL_FROM
    || localValues.EMAIL_FROM
  );
  const recipients = resolveRecipientList(
    process.env.QA_REPORT_EMAIL_TO
    || process.env.QA_REPORT_RECIPIENTS
    || localValues.QA_REPORT_EMAIL_TO
  );
  const hasFailures = checks.some(check => !check.ok);
  const statusText = hasFailures ? 'FAIL' : 'PASS';
  const reportRelativePath = path.relative(root, reportPath);

  if (!recipients.length) {
    console.log('[qa] Email report skipped (QA_REPORT_EMAIL_TO not set).');
    return;
  }
  if (!sendgridApiKey || !fromEmail) {
    console.log('[qa] Email report skipped (missing SENDGRID_API_KEY or EMAIL_FROM).');
    return;
  }

  const summaryLines = checks.map(check => {
    const minutes = (check.durationMs / 60000).toFixed(2);
    return `- ${check.name}: ${check.ok ? 'PASS' : 'FAIL'} (exit ${check.code}, ${minutes} min)`;
  });
  const subject = `[QA ${statusText}] ${now.toISOString().slice(0, 10)} - Pathflow nightly checks`;
  const text = [
    `QA status: ${statusText}`,
    `Generated: ${now.toISOString()}`,
    `Workspace: ${root}`,
    '',
    'Results:',
    ...summaryLines,
    '',
    `Report file: ${reportRelativePath}`
  ].join('\n');

  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sendgridApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: recipients.map(email => ({ email })) }],
        from: { email: fromEmail },
        subject,
        content: [{ type: 'text/plain', value: text }]
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[qa] Email report failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
      return;
    }

    console.log(`[qa] Email report sent to ${recipients.join(', ')}.`);
  } catch (err) {
    console.error(`[qa] Email report failed: ${String(err && err.message || err)}`);
  }
}

const checks = [
  runAndCapture('unit', 'npm', ['run', 'test:unit:ci']),
  runAndCapture('e2e', 'npm', ['run', 'test:e2e'])
];

const coverage = readCoverageSummary();
const reportPath = path.join(qaDir, `${stamp}-report.md`);

const lines = [];
lines.push(`# Daily QA Report`);
lines.push('');
lines.push(`- Generated: ${now.toISOString()}`);
lines.push(`- Workspace: ${root}`);
lines.push('');
lines.push('## Results');

for (const check of checks) {
  const minutes = (check.durationMs / 60000).toFixed(2);
  lines.push(`- ${check.name}: ${check.ok ? 'PASS' : 'FAIL'} (exit ${check.code}, ${minutes} min)`);
  lines.push(`  - log: ${path.relative(root, check.logPath)}`);
}

if (coverage) {
  lines.push('');
  lines.push('## Coverage (unit tests)');
  lines.push(`- Lines: ${coverage.lines?.pct ?? 'n/a'}%`);
  lines.push(`- Statements: ${coverage.statements?.pct ?? 'n/a'}%`);
  lines.push(`- Functions: ${coverage.functions?.pct ?? 'n/a'}%`);
  lines.push(`- Branches: ${coverage.branches?.pct ?? 'n/a'}%`);
}

lines.push('');
lines.push('## Artifacts');
lines.push('- Unit coverage HTML: coverage/web/index.html');
lines.push('- Playwright HTML: playwright-report/index.html');
lines.push('- Playwright JUnit XML: test-results/playwright/junit.xml');

fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');

await sendQaEmailReport({ checks, reportPath, now });

const failed = checks.filter(check => !check.ok);
if (failed.length) {
  console.error(`[qa] Failed checks: ${failed.map(check => check.name).join(', ')}`);
  console.error(`[qa] Report: ${path.relative(root, reportPath)}`);
  process.exit(1);
}

console.log(`[qa] All checks passed.`);
console.log(`[qa] Report: ${path.relative(root, reportPath)}`);
