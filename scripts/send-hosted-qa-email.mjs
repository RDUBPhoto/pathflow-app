import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const junitPath = path.join(root, 'test-results', 'playwright', 'hosted-junit.xml');

function asText(value) {
  return value == null ? '' : String(value).trim();
}

function resolveRecipientList(raw) {
  return String(raw || '')
    .split(/[,\s;]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseHostedJunit(xml) {
  const aggregate =
    xml.match(/<testsuites\b[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"[^>]*\berrors="(\d+)"[^>]*\bskipped="(\d+)"/i) ||
    xml.match(/<testsuite\b[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"[^>]*\berrors="(\d+)"[^>]*\bskipped="(\d+)"/i);

  if (aggregate) {
    const tests = Number(aggregate[1] || 0);
    const failures = Number(aggregate[2] || 0);
    const errors = Number(aggregate[3] || 0);
    const skipped = Number(aggregate[4] || 0);
    const passed = Math.max(0, tests - failures - errors - skipped);
    return { tests, passed, failures, errors, skipped };
  }

  const suites = [...xml.matchAll(/<testcase\b[^>]*>([\s\S]*?)<\/testcase>/gi)];
  if (!suites.length) return null;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  for (const item of suites) {
    const body = item[1] || '';
    if (/<failure\b/i.test(body)) failures += 1;
    else if (/<error\b/i.test(body)) errors += 1;
    else if (/<skipped\b/i.test(body)) skipped += 1;
  }
  const tests = suites.length;
  const passed = Math.max(0, tests - failures - errors - skipped);
  return { tests, passed, failures, errors, skipped };
}

async function main() {
  const sendgridApiKey = asText(process.env.SENDGRID_API_KEY);
  const fromEmail = asText(process.env.QA_REPORT_EMAIL_FROM || process.env.EMAIL_FROM);
  const recipients = resolveRecipientList(process.env.QA_REPORT_EMAIL_TO || process.env.QA_REPORT_RECIPIENTS);

  if (!recipients.length) {
    console.log('[hosted-qa] Email skipped (QA_REPORT_EMAIL_TO not set).');
    return;
  }
  if (!sendgridApiKey || !fromEmail) {
    console.log('[hosted-qa] Email skipped (missing SENDGRID_API_KEY or EMAIL_FROM).');
    return;
  }

  const now = new Date();
  const baseUrl = asText(process.env.PLAYWRIGHT_BASE_URL);
  const runUrl = (() => {
    const server = asText(process.env.GITHUB_SERVER_URL || 'https://github.com');
    const repo = asText(process.env.GITHUB_REPOSITORY);
    const runId = asText(process.env.GITHUB_RUN_ID);
    return repo && runId ? `${server}/${repo}/actions/runs/${runId}` : '';
  })();

  let summary = null;
  if (fs.existsSync(junitPath)) {
    try {
      const xml = fs.readFileSync(junitPath, 'utf8');
      summary = parseHostedJunit(xml);
    } catch (err) {
      console.error(`[hosted-qa] Could not read junit file: ${String(err && err.message || err)}`);
    }
  }

  const hasFailures = !summary || (summary.failures + summary.errors) > 0;
  const statusText = hasFailures ? 'FAIL' : 'PASS';
  const subject = `[Hosted QA ${statusText}] ${now.toISOString().slice(0, 10)} - Pathflow smoke`;

  const lines = [
    `Hosted QA status: ${statusText}`,
    `Generated: ${now.toISOString()}`,
    baseUrl ? `Target URL: ${baseUrl}` : 'Target URL: (not set)',
    '',
    'Results:',
    summary
      ? `- Tests: ${summary.tests} | Passed: ${summary.passed} | Failed: ${summary.failures} | Errors: ${summary.errors} | Skipped: ${summary.skipped}`
      : '- JUnit summary unavailable (check workflow logs/artifacts).',
    `- JUnit file: ${path.relative(root, junitPath)}`,
    runUrl ? `- GitHub run: ${runUrl}` : ''
  ].filter(Boolean);

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
        content: [{ type: 'text/plain', value: lines.join('\n') }]
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[hosted-qa] Email failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
      return;
    }

    console.log(`[hosted-qa] Email sent to ${recipients.join(', ')}.`);
  } catch (err) {
    console.error(`[hosted-qa] Email failed: ${String(err && err.message || err)}`);
  }
}

await main();
