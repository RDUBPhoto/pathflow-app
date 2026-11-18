const test = require('node:test');
const assert = require('node:assert/strict');
const { assertDevSafety } = require('../../scripts/dev-safety.cjs');
const safe = {
  PATHFLOW_ENVIRONMENT: 'development',
  SQL_CONNECTION_STRING: 'Server=example;Database=pathflow-dev;',
  SQL_TENANT_ROUTING_ENABLED: 'false',
  EMAIL_MODE: 'mock', SMS_MODE: 'mock',
  AzureWebJobsStorage: 'UseDevelopmentStorage=true',
  STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true'
};
test('local startup allows isolated development settings', () => assert.doesNotThrow(() => assertDevSafety(safe)));
for (const override of [
  { SQL_CONNECTION_STRING: 'Server=example;Database=production;' },
  { SQL_TENANT_ROUTING_ENABLED: 'true' },
  { EMAIL_MODE: 'azure' },
  { SMS_MODE: 'azure' },
  { STORAGE_CONNECTION_STRING: 'AccountName=production;' },
  { ACS_CONNECTION_STRING: 'live-key' },
  { PATHFLOW_ENVIRONMENT: '' }
]) {
  test(`local startup rejects unsafe ${Object.keys(override)[0]}`, () => {
    assert.throws(() => assertDevSafety({ ...safe, ...override }));
  });
}
