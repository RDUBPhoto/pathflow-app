// Explicit operator tool: creates a contained dev-only SQL user, then replaces
// local settings with safe defaults. Never copies production customer data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sql = require('mssql');

async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Requires --apply.');
  const settingsPath = path.resolve(__dirname, '../local.settings.json');
  const original = fs.readFileSync(settingsPath, 'utf8');
  const settings = JSON.parse(original);
  const source = settings.Values.SQL_CONNECTION_STRING;
  if (!source) throw new Error('Expected existing SQL_CONNECTION_STRING.');
  const adminConfig = new sql.ConnectionPool(source).config;
  if (adminConfig.server !== 'pathflow-sql-prod.database.windows.net') {
    throw new Error('Unexpected SQL server; refusing configuration changes.');
  }
  const database = 'pathflow-dev';
  if (adminConfig.database === database) throw new Error('Local settings already point at development.');
  const user = 'pathflow_local_dev';
  const password = crypto.randomBytes(32).toString('hex') + 'Aa!';
  const admin = await new sql.ConnectionPool({ ...adminConfig, database }).connect();
  let dev;
  try {
    const found = await admin.request().query(`SELECT name FROM sys.database_principals WHERE name = '${user}'`);
    if (found.recordset.length) throw new Error('Dev principal already exists; refusing to rotate it implicitly.');
    await admin.request().query(`CREATE USER [${user}] WITH PASSWORD = '${password}';
      ALTER ROLE db_datareader ADD MEMBER [${user}];
      ALTER ROLE db_datawriter ADD MEMBER [${user}];
      ALTER ROLE db_ddladmin ADD MEMBER [${user}];`);
    const devConfig = { ...adminConfig, database, user, password };
    dev = await new sql.ConnectionPool(devConfig).connect();
    const identity = await dev.request().query('SELECT DB_NAME() AS db, USER_NAME() AS username');
    if (identity.recordset[0].db !== database || identity.recordset[0].username !== user) {
      throw new Error('Development identity verification failed.');
    }
    let unexpectedProductionAccess = false;
    try {
      const probe = await new sql.ConnectionPool({ ...devConfig, database: adminConfig.database, connectionTimeout: 5000 }).connect();
      unexpectedProductionAccess = true;
      await probe.close();
    } catch (error) {
      if (!['ELOGIN', 'ELOGINFAILED'].includes(error.code)) throw new Error('Could not verify production access denial.');
    }
    if (unexpectedProductionAccess) throw new Error('Development credentials unexpectedly accessed production.');
    const values = {
      FUNCTIONS_WORKER_RUNTIME: 'node',
      AzureWebJobsStorage: 'UseDevelopmentStorage=true',
      STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
      DATA_BACKEND: 'sql',
      SQL_CONNECTION_STRING: `Server=${adminConfig.server};Database=${database};User Id=${user};Password=${password};Encrypt=true;TrustServerCertificate=false;`,
      SQL_DATABASE: database,
      SQL_CATALOG_DATABASE: database,
      SQL_TENANT_ROUTING_ENABLED: 'false',
      EMAIL_MODE: 'mock',
      SMS_MODE: 'mock',
      NEXPART_ENABLED: 'false',
      DEFAULT_TENANT_ID: settings.Values.DEFAULT_TENANT_ID || 'primary-location',
      PATHFLOW_ENVIRONMENT: 'development',
      WIDGET_BRAND_NAME: 'Pathflow Development',
      WIDGET_API_KEY: crypto.randomBytes(24).toString('hex'),
      WIDGET_ALLOWED_ORIGINS: 'http://localhost:4200',
      WIDGET_ALLOW_SAME_ORIGIN_FORM: 'true'
    };
    // Restricted, ignored backup preserves the previous configuration for recovery.
    const backup = `${settingsPath}.bak.pre-isolation-${Date.now()}`;
    fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, Values: values }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(settingsPath, 0o600);
    console.log('Development SQL login verified; production access denied. Local outbound providers disabled.');
    console.log('Previous settings preserved in a restricted, git-ignored backup. Restart the local host to apply.');
  } finally {
    if (dev) await dev.close();
    await admin.close();
  }
}

if (require.main === module) main().catch(() => {
  // SQL/CLI errors may contain sensitive credentials; do not print them.
  console.error('Development isolation did not complete. Local settings were not intentionally changed before verification.');
  process.exitCode = 1;
});
