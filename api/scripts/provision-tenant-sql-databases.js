#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const {
  TableClient,
  isSqlBackendEnabled,
  ensureTenantSqlDatabase,
  getTenantSqlDatabase,
  sqlCatalogDatabaseName
} = require("../_shared/table-client");
const { sanitizeTenantId } = require("../_shared/tenant");

const SQL_ENTITY_TABLE = "PathflowEntities";
const TENANTS_TABLE = "tenants";
const TENANTS_PARTITION = "v1";

function loadLocalSettingsFallback() {
  const settingsPath = path.resolve(__dirname, "..", "local.settings.json");
  if (!fs.existsSync(settingsPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const values = parsed && parsed.Values && typeof parsed.Values === "object" ? parsed.Values : {};
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] !== undefined) continue;
      if (value == null) continue;
      process.env[key] = String(value);
    }
  } catch (err) {
    console.warn("Warning: unable to parse local.settings.json:", err && err.message ? err.message : err);
  }
}

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function escapeFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function sqlConnectionString() {
  return asString(process.env.SQL_CONNECTION_STRING || process.env.AZURE_SQL_CONNECTION_STRING);
}

function sqlConfigFromEnv() {
  const conn = sqlConnectionString();
  if (conn) return conn;

  const server = asString(process.env.SQL_SERVER || process.env.AZURE_SQL_SERVER);
  const database = asString(process.env.SQL_DATABASE || process.env.AZURE_SQL_DATABASE);
  const user = asString(process.env.SQL_USER || process.env.AZURE_SQL_USER);
  const password = asString(process.env.SQL_PASSWORD || process.env.AZURE_SQL_PASSWORD);
  if (!server || !database || !user || !password) return null;

  return {
    server,
    database,
    user,
    password,
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT_MS || 120000),
    connectionTimeout: Number(process.env.SQL_CONNECTION_TIMEOUT_MS || 30000),
    options: {
      encrypt: true,
      trustServerCertificate: false
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };
}

function extractConnectionStringField(connectionString, keyPattern) {
  const rx = new RegExp(`(?:^|;)\\s*${keyPattern}\\s*=\\s*([^;]+)`, "i");
  const match = String(connectionString || "").match(rx);
  return asString(match && match[1]);
}

function setConnectionStringDatabase(connectionString, databaseName) {
  const input = asString(connectionString);
  const targetDb = asString(databaseName);
  if (!input || !targetDb) return input;

  const initialCatalogRx = /(^|;)\s*Initial\s+Catalog\s*=\s*([^;]*)/i;
  if (initialCatalogRx.test(input)) {
    return input.replace(initialCatalogRx, `$1Initial Catalog=${targetDb}`);
  }

  const databaseRx = /(^|;)\s*Database\s*=\s*([^;]*)/i;
  if (databaseRx.test(input)) {
    return input.replace(databaseRx, `$1Database=${targetDb}`);
  }

  return `${input.replace(/;*$/, "")};Initial Catalog=${targetDb};`;
}

function cloneSqlConfigWithDatabase(config, databaseName) {
  const dbName = asString(databaseName);
  if (!dbName) return config;
  if (typeof config === "string") return setConnectionStringDatabase(config, dbName);
  if (!config || typeof config !== "object") return config;
  return { ...config, database: dbName };
}

async function getPool(databaseName) {
  const config = sqlConfigFromEnv();
  if (!config) {
    throw new Error(
      "Missing SQL configuration. Set SQL_CONNECTION_STRING or SQL_SERVER/SQL_DATABASE/SQL_USER/SQL_PASSWORD."
    );
  }
  const next = cloneSqlConfigWithDatabase(config, databaseName);
  const pool = await new sql.ConnectionPool(next).connect();
  return pool;
}

async function ensureSqlSchema(pool) {
  await pool.request().query(`
IF OBJECT_ID(N'dbo.${SQL_ENTITY_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.${SQL_ENTITY_TABLE} (
    table_name NVARCHAR(128) NOT NULL,
    partition_key NVARCHAR(128) NOT NULL,
    row_key NVARCHAR(256) NOT NULL,
    entity_json NVARCHAR(MAX) NOT NULL,
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_${SQL_ENTITY_TABLE}_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_${SQL_ENTITY_TABLE} PRIMARY KEY (table_name, partition_key, row_key)
  );
  CREATE INDEX IX_${SQL_ENTITY_TABLE}_table_partition ON dbo.${SQL_ENTITY_TABLE}(table_name, partition_key);
END
  `);
}

function parseArgs(argsInput) {
  const args = Array.isArray(argsInput) ? argsInput : process.argv.slice(2);
  const opts = {
    cleanup: false,
    dryRun: false,
    tenantIds: []
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = asString(args[i]);
    if (arg === "--cleanup") {
      opts.cleanup = true;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--tenant" || arg === "-t") {
      const rawNext = asString(args[i + 1]);
      if (rawNext) {
        const next = sanitizeTenantId(rawNext);
        if (next && next !== "tenant-unassigned") opts.tenantIds.push(next);
      }
      i += 1;
      continue;
    }
  }
  opts.tenantIds = Array.from(new Set(opts.tenantIds));
  return opts;
}

async function listTenantIds(tenantClient) {
  const filter = `PartitionKey eq '${escapeFilterValue(TENANTS_PARTITION)}'`;
  const iter = tenantClient.listEntities({ queryOptions: { filter } });
  const out = [];
  for await (const entity of iter) {
    const rawRowKey = asString(entity && entity.rowKey);
    if (!rawRowKey) continue;
    const tenantId = sanitizeTenantId(rawRowKey);
    if (tenantId === "tenant-unassigned") continue;
    if (!tenantId) continue;
    out.push(tenantId);
  }
  return out.sort();
}

async function upsertTenantMetadata(tenantClient, tenantId, databaseName) {
  await tenantClient.upsertEntity(
    {
      partitionKey: TENANTS_PARTITION,
      rowKey: tenantId,
      sqlDatabaseName: asString(databaseName),
      sqlDatabaseProvisionedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    "Merge"
  );
}

async function migrateTenantRows(catalogPool, tenantPool, tenantId, cleanup) {
  const selectReq = catalogPool.request();
  selectReq.input("tenantId", sql.NVarChar(128), tenantId);
  const selectResult = await selectReq.query(`
SELECT table_name, partition_key, row_key, entity_json
FROM dbo.${SQL_ENTITY_TABLE}
WHERE partition_key = @tenantId
  `);

  const rows = Array.isArray(selectResult.recordset) ? selectResult.recordset : [];
  let upserted = 0;

  for (const row of rows) {
    const request = tenantPool.request();
    request.input("tableName", sql.NVarChar(128), asString(row.table_name).toLowerCase());
    request.input("partitionKey", sql.NVarChar(128), asString(row.partition_key));
    request.input("rowKey", sql.NVarChar(256), asString(row.row_key));
    request.input("entityJson", sql.NVarChar(sql.MAX), asString(row.entity_json));
    await request.query(`
MERGE dbo.${SQL_ENTITY_TABLE} AS target
USING (SELECT @tableName AS table_name, @partitionKey AS partition_key, @rowKey AS row_key, @entityJson AS entity_json) AS src
ON target.table_name = src.table_name
   AND target.partition_key = src.partition_key
   AND target.row_key = src.row_key
WHEN MATCHED THEN
  UPDATE SET entity_json = src.entity_json, updated_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (table_name, partition_key, row_key, entity_json, updated_at)
  VALUES (src.table_name, src.partition_key, src.row_key, src.entity_json, SYSUTCDATETIME());
    `);
    upserted += 1;
  }

  if (cleanup && upserted > 0) {
    const deleteReq = catalogPool.request();
    deleteReq.input("tenantId", sql.NVarChar(128), tenantId);
    await deleteReq.query(`
DELETE FROM dbo.${SQL_ENTITY_TABLE}
WHERE partition_key = @tenantId
    `);
  }

  return { scanned: rows.length, upserted };
}

async function main() {
  loadLocalSettingsFallback();

  if (!isSqlBackendEnabled()) {
    throw new Error("SQL backend is not enabled. Set DATA_BACKEND=sql (or provide SQL env vars in auto mode).");
  }

  const storageConn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!storageConn) throw new Error("Missing STORAGE_CONNECTION_STRING.");

  const options = parseArgs();
  const tenantClient = TableClient.fromConnectionString(storageConn, TENANTS_TABLE);
  await tenantClient.createTable().catch(() => {});

  const allTenantIds = await listTenantIds(tenantClient);
  const targetTenantIds = options.tenantIds.length
    ? allTenantIds.filter((tenantId) => options.tenantIds.includes(tenantId))
    : allTenantIds;

  if (!targetTenantIds.length) {
    console.log("No tenants found to process.");
    return;
  }

  const catalogDb = asString(sqlCatalogDatabaseName()) || extractConnectionStringField(sqlConnectionString(), "Initial\\s+Catalog") || extractConnectionStringField(sqlConnectionString(), "Database");
  if (!catalogDb) {
    throw new Error("Could not resolve catalog database name from SQL configuration.");
  }

  console.log(`Catalog DB: ${catalogDb}`);
  console.log(`Tenants to process: ${targetTenantIds.join(", ")}`);
  if (options.dryRun) console.log("Dry-run mode enabled: no provisioning or data migration will be performed.");

  let catalogPool = null;
  const tenantPools = new Map();
  try {
    catalogPool = await getPool(catalogDb);
    await ensureSqlSchema(catalogPool);

    let totalScanned = 0;
    let totalUpserted = 0;
    for (const tenantId of targetTenantIds) {
      if (options.dryRun) {
        console.log(`- ${tenantId}: would provision SQL DB and migrate rows.`);
        continue;
      }

      const provisioned = await ensureTenantSqlDatabase(tenantId);
      const databaseName = asString((provisioned && provisioned.databaseName) || (await getTenantSqlDatabase(tenantId)));
      if (!databaseName) throw new Error(`No SQL database mapped for tenant '${tenantId}' after provisioning.`);
      await upsertTenantMetadata(tenantClient, tenantId, databaseName);

      let tenantPool = tenantPools.get(databaseName);
      if (!tenantPool) {
        tenantPool = await getPool(databaseName);
        await ensureSqlSchema(tenantPool);
        tenantPools.set(databaseName, tenantPool);
      }

      const result = await migrateTenantRows(catalogPool, tenantPool, tenantId, options.cleanup);
      totalScanned += result.scanned;
      totalUpserted += result.upserted;
      console.log(`- ${tenantId}: db=${databaseName}, scanned=${result.scanned}, upserted=${result.upserted}`);
    }

    if (!options.dryRun) {
      console.log(`Done. Migrated ${totalUpserted}/${totalScanned} rows across ${targetTenantIds.length} tenant(s).`);
      if (options.cleanup) {
        console.log("Cleanup enabled: catalog rows for processed tenants were removed.");
      } else {
        console.log("Cleanup disabled: catalog rows retained as fallback.");
      }
    }
  } finally {
    if (catalogPool) await catalogPool.close().catch(() => {});
    for (const pool of tenantPools.values()) {
      await pool.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Provision/migrate failed:", err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs
};
