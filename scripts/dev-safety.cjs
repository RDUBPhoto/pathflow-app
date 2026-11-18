function assertDevSafety(values) {
  if (values.PATHFLOW_ENVIRONMENT !== 'development') {
    throw new Error('Local startup requires isolated development settings.');
  }
  const connection = String(values.SQL_CONNECTION_STRING || values.AZURE_SQL_CONNECTION_STRING || '');
  const database = connection.match(/(?:^|;)\s*(?:Database|Initial\s+Catalog)\s*=\s*([^;]+)/i)?.[1]?.trim();
  if (database !== 'pathflow-dev' || values.SQL_TENANT_ROUTING_ENABLED !== 'false') {
    throw new Error('Local startup refused: SQL must target pathflow-dev with tenant routing disabled.');
  }
  if (values.EMAIL_MODE !== 'mock' || values.SMS_MODE !== 'mock') {
    throw new Error('Local startup refused: outbound email and SMS must be mocked.');
  }
  for (const key of ['AzureWebJobsStorage', 'STORAGE_CONNECTION_STRING']) {
    if (values[key] !== 'UseDevelopmentStorage=true') {
      throw new Error('Local startup refused: storage must use the local emulator.');
    }
  }
  for (const key of ['ACS_CONNECTION_STRING', 'ACS_EMAIL_CONNECTION_STRING', 'SENDGRID_API_KEY', 'EASYPOST_API_KEY', 'NEXPART_API_KEY', 'NEXPART_BEARER_TOKEN', 'POWERBI_CLIENT_SECRET', 'VIN_OCR_KEY']) {
    if (values[key]) throw new Error(`Local startup refused: remove live ${key}.`);
  }
}
module.exports = { assertDevSafety };
