import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./send-hosted-qa-email.mjs', import.meta.url));

function runReport({ status = 202, networkError = false, senderOverride = true } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pathflow-qa-email-'));
  try {
    mkdirSync(path.join(directory, 'test-results/playwright'), { recursive: true });
    writeFileSync(path.join(directory, 'test-results/playwright/hosted-junit.xml'),
      '<testsuites tests="14" failures="0" errors="0" skipped="0"></testsuites>');
    const expectedSender = senderOverride ? 'verified@example.com' : 'fallback@example.com';
    const preload = path.join(directory, 'mock-sendgrid.mjs');
    // Replace fetch before loading the report. These tests never contact SendGrid.
    writeFileSync(preload, `
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://api.sendgrid.com/v3/mail/send') throw new Error('Unexpected network destination');
        const body = JSON.parse(options.body);
        if (body.from.email !== ${JSON.stringify(expectedSender)}) throw new Error('Wrong sender selected');
        if (body.personalizations[0].to[0].email !== 'reports@example.com') throw new Error('Wrong recipient selected');
        if (${JSON.stringify(networkError)}) throw new Error('Simulated network failure');
        return new Response(${JSON.stringify(status === 403
          ? '{"errors":[{"message":"The from address does not match a verified Sender Identity."}]}'
          : '')}, { status: ${status} });
      };
    `);
    return spawnSync(process.execPath, ['--import', preload, script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        SENDGRID_API_KEY: 'fake-test-key-no-network',
        EMAIL_FROM: 'fallback@example.com',
        QA_REPORT_EMAIL_FROM: senderOverride ? 'verified@example.com' : '',
        QA_REPORT_EMAIL_TO: 'reports@example.com',
        PLAYWRIGHT_BASE_URL: 'https://example.com',
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('accepted QA report uses the explicit verified-sender override', () => {
  const result = runReport();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Email sent to reports@example\.com/);
});

test('the existing EMAIL_FROM remains the fallback', () => {
  const result = runReport({ senderOverride: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Email sent/);
});

test('unverified SendGrid sender fails the job with a concrete correction', () => {
  const result = runReport({ status: 403 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Email failed: HTTP 403/);
  assert.match(result.stderr, /Configure QA_REPORT_EMAIL_FROM with a verified SendGrid sender/);
  assert.doesNotMatch(result.stdout, /Email sent/);
});

test('network failure cannot be reported as a successful email step', () => {
  const result = runReport({ networkError: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Simulated network failure/);
  assert.doesNotMatch(result.stdout, /Email sent/);
});
