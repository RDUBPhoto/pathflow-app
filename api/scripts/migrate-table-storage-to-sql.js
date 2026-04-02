#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { TableClient } = require("@azure/data-tables");
const sql = require("mssql");

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

loadLocalSettingsFallback();

const SQL_ENTITY_TABLE = process.env.SQL_ENTITY_TABLE || "PathflowEntities";
const TABLES = [
  "appsettings",
  "customers",
  "customernotduplicates",
  "emailmessages",
  "emailtemplates",
  "emailverifications",
  "events",
  "inventoryitems",
  "inventoryneeds",
  "invoiceresponses",
  "lanes",
  "notifications",
  "purchaseorders",
  "quoteresponses",
  "schedule",
  "smsmessages",
  "smssenders",
  "tenants",
  "useraccess",
  "workitems"
];

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function sqlConfigFromEnv() {
  const conn = asString(process.env.SQL_CONNECTION_STRING || process.env.AZURE_SQL_CONNECTION_STRING);
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

function stripUndefined(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined) continue;
    if (typeof value === "function" || typeof value === "symbol") continue;
    out[key] = value;
  }
  return out;
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

async function upsertEntity(pool, tableName, entity) {
  const clean = stripUndefined(entity);
  const partitionKey = asString(clean.partitionKey || clean.PartitionKey);
  const rowKey = asString(clean.rowKey || clean.RowKey);
  if (!partitionKey || !rowKey) return false;

  clean.partitionKey = partitionKey;
  clean.rowKey = rowKey;

  const request = pool.request();
  request.input("tableName", sql.NVarChar(128), asString(tableName).toLowerCase());
  request.input("partitionKey", sql.NVarChar(128), partitionKey);
  request.input("rowKey", sql.NVarChar(256), rowKey);
  request.input("entityJson", sql.NVarChar(sql.MAX), JSON.stringify(clean));
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
  return true;
}

async function tableExists(client) {
  try {
    // Query a single entity; if table does not exist, Azure returns 404/ResourceNotFound.
    const iter = client.listEntities();
    // eslint-disable-next-line no-unused-vars
    for await (const _ of iter) {
      break;
    }
    return true;
  } catch (err) {
    const message = asString(err && err.message).toLowerCase();
    const statusCode = Number(err && err.statusCode);
    if (statusCode === 404 || message.includes("table not found") || message.includes("resourcenotfound")) {
      return false;
    }
    throw err;
  }
}

async function migrateTable(storageConn, pool, tableName) {
  const tableClient = TableClient.fromConnectionString(storageConn, tableName);
  const exists = await tableExists(tableClient);
  if (!exists) {
    console.log(`- ${tableName}: skipped (table not found)`);
    return { scanned: 0, written: 0, skipped: true };
  }

  let scanned = 0;
  let written = 0;
  const iter = tableClient.listEntities();
  for await (const entity of iter) {
    scanned += 1;
    const ok = await upsertEntity(pool, tableName, entity);
    if (ok) written += 1;
  }
  console.log(`- ${tableName}: scanned ${scanned}, upserted ${written}`);
  return { scanned, written, skipped: false };
}

async function main() {
  const storageConn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!storageConn) {
    throw new Error("Missing STORAGE_CONNECTION_STRING.");
  }

  const config = sqlConfigFromEnv();
  if (!config) {
    throw new Error(
      "Missing SQL configuration. Set SQL_CONNECTION_STRING or SQL_SERVER/SQL_DATABASE/SQL_USER/SQL_PASSWORD."
    );
  }

  const pool = await new sql.ConnectionPool(config).connect();
  await ensureSqlSchema(pool);

  let totalScanned = 0;
  let totalWritten = 0;
  for (const tableName of TABLES) {
    const result = await migrateTable(storageConn, pool, tableName);
    totalScanned += result.scanned;
    totalWritten += result.written;
  }

  console.log(`Migration complete. Scanned ${totalScanned} entities, upserted ${totalWritten} entities.`);
  await pool.close();
}

main().catch((err) => {
  console.error("Migration failed:", err && err.message ? err.message : err);
  process.exitCode = 1;
});
