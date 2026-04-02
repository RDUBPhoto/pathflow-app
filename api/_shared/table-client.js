const { TableClient: AzureTableClient } = require("@azure/data-tables");

let sql = null;
try {
  sql = require("mssql");
} catch (_) {
  sql = null;
}

const SQL_ENTITY_TABLE = "PathflowEntities";
const SQL_TENANT_MAP_TABLE = asString(process.env.SQL_TENANT_MAP_TABLE || "TenantSqlDatabases") || "TenantSqlDatabases";
const GLOBAL_SQL_TABLES = new Set([
  "useraccess",
  "tenants",
  "emailverifications",
  SQL_TENANT_MAP_TABLE.toLowerCase()
]);

const poolByKey = new Map();
const schemaByPoolKey = new Map();
const tenantDatabaseCache = new Map();
let tenantMapSchemaPromise = null;

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const lowered = asString(value).toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
}

function parseJsonSafe(raw, fallback = {}) {
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function backendPreference() {
  const raw = asString(process.env.DATA_BACKEND || process.env.STORAGE_BACKEND).toLowerCase();
  if (raw === "sql") return "sql";
  if (raw === "table") return "table";
  return "auto";
}

function tenantRoutingEnabled() {
  const raw = asString(process.env.SQL_TENANT_ROUTING_ENABLED);
  if (!raw) return true;
  return toBool(raw);
}

function tenantRoutingStrict() {
  return toBool(process.env.SQL_TENANT_ROUTING_STRICT);
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

function sqlReady() {
  return !!sqlConfigFromEnv();
}

function shouldUseSqlBackend() {
  const pref = backendPreference();
  if (pref === "sql") return true;
  if (pref === "table") return false;
  return sqlReady();
}

function sanitizeTenantId(value) {
  const cleaned = asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned;
}

function sanitizeDatabaseName(value) {
  const cleaned = asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned;
}

function tenantDbPrefix() {
  const fromEnv = sanitizeDatabaseName(asString(process.env.SQL_TENANT_DB_PREFIX || ""));
  return fromEnv || "pathflow_tenant";
}

function buildTenantDatabaseName(tenantId) {
  const safeTenant = sanitizeDatabaseName(tenantId);
  if (!safeTenant) return "";
  const base = `${tenantDbPrefix()}_${safeTenant}`;
  return base.slice(0, 120);
}

function extractConnectionStringField(connectionString, keyPattern) {
  const rx = new RegExp(`(?:^|;)\\s*${keyPattern}\\s*=\\s*([^;]+)`, "i");
  const match = String(connectionString || "").match(rx);
  return asString(match && match[1]);
}

function getConnectionStringDatabase(connectionString) {
  return (
    extractConnectionStringField(connectionString, "Initial\\s+Catalog") ||
    extractConnectionStringField(connectionString, "Database")
  );
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

function getSqlConfigDatabaseName(config) {
  if (typeof config === "string") {
    return getConnectionStringDatabase(config);
  }
  if (config && typeof config === "object") {
    return asString(config.database);
  }
  return "";
}

function cloneSqlConfigWithDatabase(config, databaseName) {
  const dbName = asString(databaseName);
  if (!dbName) return config;
  if (typeof config === "string") {
    return setConnectionStringDatabase(config, dbName);
  }
  if (!config || typeof config !== "object") return config;
  return {
    ...config,
    database: dbName
  };
}

function catalogDatabaseName() {
  const explicit = asString(process.env.SQL_CATALOG_DATABASE || process.env.AZURE_SQL_CATALOG_DATABASE);
  if (explicit) return explicit;
  const base = sqlConfigFromEnv();
  return getSqlConfigDatabaseName(base);
}

function poolKeyForConfig(config, keyHint = "") {
  if (keyHint) return keyHint;
  if (typeof config === "string") return `conn:${config}`;
  const server = asString(config && config.server);
  const db = asString(config && config.database);
  const user = asString(config && config.user);
  return `cfg:${server}|${db}|${user}`;
}

async function getPoolForConfig(config, keyHint = "") {
  if (!sql) {
    throw new Error("SQL backend selected but 'mssql' package is not installed in api dependencies.");
  }
  if (!config) {
    throw new Error(
      "SQL backend selected but SQL connection is not configured. Set SQL_CONNECTION_STRING (or SQL_SERVER/SQL_DATABASE/SQL_USER/SQL_PASSWORD)."
    );
  }

  const poolKey = poolKeyForConfig(config, keyHint);
  if (!poolByKey.has(poolKey)) {
    const promise = new sql.ConnectionPool(config).connect().then((pool) => {
      Object.defineProperty(pool, "__pathflowPoolKey", { value: poolKey, enumerable: false, configurable: true });
      return pool;
    });
    poolByKey.set(poolKey, promise);
  }
  return poolByKey.get(poolKey);
}

async function getCatalogPool() {
  const config = sqlConfigFromEnv();
  return getPoolForConfig(config, "catalog");
}

async function getMasterPool() {
  const config = cloneSqlConfigWithDatabase(sqlConfigFromEnv(), "master");
  return getPoolForConfig(config, "master");
}

async function getDatabasePool(databaseName) {
  const db = asString(databaseName);
  if (!db) return getCatalogPool();
  const config = cloneSqlConfigWithDatabase(sqlConfigFromEnv(), db);
  return getPoolForConfig(config, `db:${db.toLowerCase()}`);
}

async function ensureSqlSchemaForPool(pool, poolKey) {
  const key = asString(poolKey) || asString(pool && pool.__pathflowPoolKey) || "default";
  if (!schemaByPoolKey.has(key)) {
    const schemaPromise = pool.request().query(`
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
    `).catch((err) => {
      schemaByPoolKey.delete(key);
      throw err;
    });
    schemaByPoolKey.set(key, schemaPromise);
  }
  return schemaByPoolKey.get(key);
}

async function ensureTenantMapSchema() {
  if (!tenantMapSchemaPromise) {
    tenantMapSchemaPromise = (async () => {
      const catalogPool = await getCatalogPool();
      await catalogPool.request().query(`
IF OBJECT_ID(N'dbo.${SQL_TENANT_MAP_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.${SQL_TENANT_MAP_TABLE} (
    tenant_id NVARCHAR(128) NOT NULL,
    database_name NVARCHAR(128) NOT NULL,
    status NVARCHAR(32) NOT NULL CONSTRAINT DF_${SQL_TENANT_MAP_TABLE}_status DEFAULT N'active',
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_${SQL_TENANT_MAP_TABLE}_created DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_${SQL_TENANT_MAP_TABLE}_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_${SQL_TENANT_MAP_TABLE} PRIMARY KEY (tenant_id)
  );
  CREATE UNIQUE INDEX IX_${SQL_TENANT_MAP_TABLE}_database_name ON dbo.${SQL_TENANT_MAP_TABLE}(database_name);
END
      `);
    })().catch((err) => {
      tenantMapSchemaPromise = null;
      throw err;
    });
  }
  return tenantMapSchemaPromise;
}

async function getTenantMappedDatabaseName(tenantId) {
  const tenant = sanitizeTenantId(tenantId);
  if (!tenant || !tenantRoutingEnabled() || !shouldUseSqlBackend()) return "";
  if (tenantDatabaseCache.has(tenant)) return tenantDatabaseCache.get(tenant) || "";

  await ensureTenantMapSchema();
  const catalogPool = await getCatalogPool();
  const request = catalogPool.request();
  request.input("tenantId", sql.NVarChar(128), tenant);
  const result = await request.query(`
SELECT TOP 1 database_name
FROM dbo.${SQL_TENANT_MAP_TABLE}
WHERE tenant_id = @tenantId
  AND status = N'active'
  `);
  const databaseName = asString(result.recordset && result.recordset[0] && result.recordset[0].database_name);
  tenantDatabaseCache.set(tenant, databaseName || "");
  return databaseName;
}

async function listTenantMappedDatabases() {
  if (!tenantRoutingEnabled() || !shouldUseSqlBackend()) return [];
  await ensureTenantMapSchema();
  const catalogPool = await getCatalogPool();
  const result = await catalogPool.request().query(`
SELECT tenant_id, database_name
FROM dbo.${SQL_TENANT_MAP_TABLE}
WHERE status = N'active'
  `);
  return (result.recordset || [])
    .map((row) => ({
      tenantId: sanitizeTenantId(row.tenant_id),
      databaseName: asString(row.database_name)
    }))
    .filter((item) => !!item.tenantId && !!item.databaseName);
}

async function upsertTenantDatabaseMapping(tenantId, databaseName) {
  const tenant = sanitizeTenantId(tenantId);
  const dbName = asString(databaseName);
  if (!tenant || !dbName) {
    throw new Error("Both tenantId and databaseName are required for tenant database mapping.");
  }

  await ensureTenantMapSchema();
  const catalogPool = await getCatalogPool();
  const request = catalogPool.request();
  request.input("tenantId", sql.NVarChar(128), tenant);
  request.input("databaseName", sql.NVarChar(128), dbName);
  await request.query(`
MERGE dbo.${SQL_TENANT_MAP_TABLE} AS target
USING (SELECT @tenantId AS tenant_id, @databaseName AS database_name) AS src
ON target.tenant_id = src.tenant_id
WHEN MATCHED THEN
  UPDATE SET database_name = src.database_name, status = N'active', updated_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (tenant_id, database_name, status, created_at, updated_at)
  VALUES (src.tenant_id, src.database_name, N'active', SYSUTCDATETIME(), SYSUTCDATETIME());
  `);

  tenantDatabaseCache.set(tenant, dbName);
}

async function createDatabaseIfMissing(databaseName) {
  const dbName = asString(databaseName);
  if (!dbName) {
    throw new Error("databaseName is required.");
  }

  const masterPool = await getMasterPool();
  const request = masterPool.request();
  request.input("dbName", sql.NVarChar(128), dbName);
  await request.query(`
IF DB_ID(@dbName) IS NULL
BEGIN
  DECLARE @sql NVARCHAR(MAX) = N'CREATE DATABASE [' + REPLACE(@dbName, N']', N']]') + N']';
  EXEC(@sql);
END
  `).catch((err) => {
    const message = asString(err && err.message).toLowerCase();
    if (message.includes("already exists")) return;
    throw err;
  });
}

async function waitForDatabaseOnline(databaseName, maxAttempts = 30, delayMs = 1000) {
  const dbName = asString(databaseName);
  if (!dbName) return false;
  const masterPool = await getMasterPool();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const request = masterPool.request();
    request.input("dbName", sql.NVarChar(128), dbName);
    const result = await request.query(`
SELECT TOP 1 state_desc
FROM sys.databases
WHERE name = @dbName
    `);
    const stateDesc = asString(result.recordset && result.recordset[0] && result.recordset[0].state_desc).toUpperCase();
    if (stateDesc === "ONLINE") return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function ensureTenantSqlDatabase(tenantId, options = {}) {
  if (!shouldUseSqlBackend() || !tenantRoutingEnabled()) return null;

  const tenant = sanitizeTenantId(tenantId);
  if (!tenant) {
    throw new Error("A valid tenant id is required to provision SQL tenant database.");
  }

  const existing = await getTenantMappedDatabaseName(tenant);
  if (existing) {
    return { tenantId: tenant, databaseName: existing, created: false };
  }

  const preferred = sanitizeDatabaseName(asString(options.databaseName));
  const nextDbName = preferred || buildTenantDatabaseName(tenant);
  if (!nextDbName) {
    throw new Error(`Could not derive database name for tenant '${tenant}'.`);
  }

  await createDatabaseIfMissing(nextDbName);
  await waitForDatabaseOnline(nextDbName);

  const tenantPool = await getDatabasePool(nextDbName);
  await ensureSqlSchemaForPool(tenantPool, `db:${nextDbName.toLowerCase()}`);

  await upsertTenantDatabaseMapping(tenant, nextDbName);
  return { tenantId: tenant, databaseName: nextDbName, created: true };
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

function buildEntity(row) {
  const parsed = parseJsonSafe(row.entity_json, {});
  const entity = { ...parsed };
  entity.partitionKey = asString(entity.partitionKey || row.partition_key);
  entity.rowKey = asString(entity.rowKey || row.row_key);
  const ts =
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : asString(row.updated_at) || asString(entity.timestamp);
  if (ts) entity.timestamp = ts;
  return entity;
}

function tokenizeFilter(input) {
  const source = asString(input);
  const tokens = [];
  let i = 0;

  function isAlpha(ch) {
    return /[A-Za-z_]/.test(ch);
  }

  function isAlnum(ch) {
    return /[A-Za-z0-9_.-]/.test(ch);
  }

  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "LPAREN" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN" });
      i += 1;
      continue;
    }
    if (ch === "'") {
      let value = "";
      i += 1;
      while (i < source.length) {
        const current = source[i];
        if (current === "'") {
          if (source[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += current;
        i += 1;
      }
      tokens.push({ type: "STRING", value });
      continue;
    }
    if (isAlpha(ch)) {
      let value = ch;
      i += 1;
      while (i < source.length && isAlnum(source[i])) {
        value += source[i];
        i += 1;
      }
      const lowered = value.toLowerCase();
      if (lowered === "and") {
        tokens.push({ type: "AND" });
      } else if (lowered === "or") {
        tokens.push({ type: "OR" });
      } else if (lowered === "eq") {
        tokens.push({ type: "EQ" });
      } else if (lowered === "true") {
        tokens.push({ type: "BOOLEAN", value: true });
      } else if (lowered === "false") {
        tokens.push({ type: "BOOLEAN", value: false });
      } else if (lowered === "null") {
        tokens.push({ type: "NULL", value: null });
      } else {
        tokens.push({ type: "IDENT", value });
      }
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = ch;
      i += 1;
      while (i < source.length && /[0-9.]/.test(source[i])) {
        value += source[i];
        i += 1;
      }
      const num = Number(value);
      if (!Number.isFinite(num)) {
        throw new Error(`Unsupported numeric literal in filter: ${value}`);
      }
      tokens.push({ type: "NUMBER", value: num });
      continue;
    }
    throw new Error(`Unsupported token in filter near '${source.slice(i, i + 16)}'`);
  }

  tokens.push({ type: "EOF" });
  return tokens;
}

function parseFilter(input) {
  const tokens = tokenizeFilter(input);
  let index = 0;

  function peek() {
    return tokens[index];
  }

  function take(type) {
    const token = peek();
    if (!token || token.type !== type) {
      throw new Error(`Expected ${type} but found ${(token && token.type) || "EOF"}`);
    }
    index += 1;
    return token;
  }

  function parseValueToken() {
    const token = peek();
    if (!token) throw new Error("Unexpected end of filter.");
    if (token.type === "STRING" || token.type === "BOOLEAN" || token.type === "NULL" || token.type === "NUMBER") {
      index += 1;
      return token.value;
    }
    throw new Error(`Expected filter literal but found ${token.type}`);
  }

  function parseComparison() {
    const field = take("IDENT").value;
    take("EQ");
    const value = parseValueToken();
    return { type: "cmp", field, op: "eq", value };
  }

  function parseFactor() {
    const token = peek();
    if (token.type === "LPAREN") {
      take("LPAREN");
      const expr = parseOr();
      take("RPAREN");
      return expr;
    }
    return parseComparison();
  }

  function parseAnd() {
    let left = parseFactor();
    while (peek().type === "AND") {
      take("AND");
      const right = parseFactor();
      left = { type: "and", left, right };
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek().type === "OR") {
      take("OR");
      const right = parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  const ast = parseOr();
  take("EOF");
  return ast;
}

function fieldValue(entity, field) {
  if (/^PartitionKey$/i.test(field)) return entity.partitionKey;
  if (/^RowKey$/i.test(field)) return entity.rowKey;
  if (/^Timestamp$/i.test(field)) return entity.timestamp;
  if (Object.prototype.hasOwnProperty.call(entity, field)) return entity[field];

  const lookup = String(field).toLowerCase();
  for (const [key, value] of Object.entries(entity || {})) {
    if (String(key).toLowerCase() === lookup) return value;
  }
  return undefined;
}

function eqCompare(actual, expected) {
  if (typeof expected === "boolean") return toBool(actual) === expected;
  if (typeof expected === "number") return Number(actual) === expected;
  if (expected === null) return actual == null || actual === "";
  return asString(actual) === expected;
}

function evalFilterAst(ast, entity) {
  if (!ast) return true;
  if (ast.type === "and") return evalFilterAst(ast.left, entity) && evalFilterAst(ast.right, entity);
  if (ast.type === "or") return evalFilterAst(ast.left, entity) || evalFilterAst(ast.right, entity);
  if (ast.type === "cmp") {
    const actual = fieldValue(entity, ast.field);
    if (ast.op === "eq") return eqCompare(actual, ast.value);
    return false;
  }
  return true;
}

function intersectionSet(a, b) {
  const out = new Set();
  for (const value of a) {
    if (b.has(value)) out.add(value);
  }
  return out;
}

function extractPartitionKeysFromAst(ast) {
  if (!ast) return null;

  if (ast.type === "cmp") {
    if (/^PartitionKey$/i.test(ast.field) && ast.op === "eq" && typeof ast.value === "string") {
      const tenant = sanitizeTenantId(ast.value);
      return tenant ? new Set([tenant]) : new Set();
    }
    return null;
  }

  if (ast.type === "and") {
    const left = extractPartitionKeysFromAst(ast.left);
    const right = extractPartitionKeysFromAst(ast.right);
    if (left && right) return intersectionSet(left, right);
    return left || right || null;
  }

  if (ast.type === "or") {
    const left = extractPartitionKeysFromAst(ast.left);
    const right = extractPartitionKeysFromAst(ast.right);
    if (left && right) return new Set([...left, ...right]);
    return null;
  }

  return null;
}

class SqlEntityTableClient {
  constructor(tableName) {
    this.tableName = asString(tableName).toLowerCase();
  }

  static fromConnectionString(_connectionString, tableName) {
    return new SqlEntityTableClient(tableName);
  }

  isGlobalTable() {
    return GLOBAL_SQL_TABLES.has(this.tableName);
  }

  async createTable() {
    const pool = await getCatalogPool();
    await ensureSqlSchemaForPool(pool, "catalog");
  }

  async resolvePoolForPartitionKey(partitionKey) {
    const catalogPool = await getCatalogPool();
    if (this.isGlobalTable() || !tenantRoutingEnabled()) {
      await ensureSqlSchemaForPool(catalogPool, "catalog");
      return catalogPool;
    }

    const tenant = sanitizeTenantId(partitionKey);
    if (!tenant) {
      await ensureSqlSchemaForPool(catalogPool, "catalog");
      return catalogPool;
    }

    const mappedDatabase = await getTenantMappedDatabaseName(tenant);
    if (!mappedDatabase) {
      if (tenantRoutingStrict()) {
        throw new Error(`No SQL database mapping exists for tenant '${tenant}'.`);
      }
      await ensureSqlSchemaForPool(catalogPool, "catalog");
      return catalogPool;
    }

    const tenantPool = await getDatabasePool(mappedDatabase);
    await ensureSqlSchemaForPool(tenantPool, `db:${mappedDatabase.toLowerCase()}`);
    return tenantPool;
  }

  async resolvePoolsForList(partitionCandidates) {
    const catalogPool = await getCatalogPool();
    await ensureSqlSchemaForPool(catalogPool, "catalog");

    if (this.isGlobalTable() || !tenantRoutingEnabled()) return [catalogPool];

    const poolMap = new Map();
    const addPool = (pool) => {
      const key = asString(pool && pool.__pathflowPoolKey) || `pool:${poolMap.size + 1}`;
      if (!poolMap.has(key)) poolMap.set(key, pool);
    };

    if (partitionCandidates instanceof Set) {
      if (!partitionCandidates.size) return [];
      for (const tenant of partitionCandidates) {
        const mappedDatabase = await getTenantMappedDatabaseName(tenant);
        if (!mappedDatabase) {
          if (tenantRoutingStrict()) {
            throw new Error(`No SQL database mapping exists for tenant '${tenant}'.`);
          }
          addPool(catalogPool);
          continue;
        }
        const tenantPool = await getDatabasePool(mappedDatabase);
        await ensureSqlSchemaForPool(tenantPool, `db:${mappedDatabase.toLowerCase()}`);
        addPool(tenantPool);
      }
      return Array.from(poolMap.values());
    }

    // Unconstrained query: query mapped tenant DBs first so tenant data wins over any legacy catalog duplicates.
    const mappings = await listTenantMappedDatabases();
    for (const mapping of mappings) {
      const dbName = asString(mapping.databaseName);
      if (!dbName) continue;
      const tenantPool = await getDatabasePool(dbName);
      await ensureSqlSchemaForPool(tenantPool, `db:${dbName.toLowerCase()}`);
      addPool(tenantPool);
    }
    addPool(catalogPool);
    return Array.from(poolMap.values());
  }

  async getEntity(partitionKey, rowKey) {
    const pool = await this.resolvePoolForPartitionKey(partitionKey);
    const request = pool.request();
    request.input("tableName", sql.NVarChar(128), this.tableName);
    request.input("partitionKey", sql.NVarChar(128), asString(partitionKey));
    request.input("rowKey", sql.NVarChar(256), asString(rowKey));
    const result = await request.query(`
SELECT TOP 1 partition_key, row_key, entity_json, updated_at
FROM dbo.${SQL_ENTITY_TABLE}
WHERE table_name = @tableName
  AND partition_key = @partitionKey
  AND row_key = @rowKey
    `);
    const row = result.recordset && result.recordset[0];
    if (!row) {
      const err = new Error("Entity not found.");
      err.statusCode = 404;
      throw err;
    }
    return buildEntity(row);
  }

  async upsertEntity(entity, mode = "Merge") {
    const normalized = stripUndefined(entity || {});
    const partitionKey = asString(normalized.partitionKey || normalized.PartitionKey);
    const rowKey = asString(normalized.rowKey || normalized.RowKey);
    if (!partitionKey || !rowKey) {
      throw new Error("upsertEntity requires partitionKey and rowKey.");
    }

    let payload = {
      ...normalized,
      partitionKey,
      rowKey
    };

    if (String(mode || "").toLowerCase() === "merge") {
      try {
        const existing = await this.getEntity(partitionKey, rowKey);
        payload = {
          ...existing,
          ...payload,
          partitionKey,
          rowKey
        };
      } catch (_) {}
    }

    const pool = await this.resolvePoolForPartitionKey(partitionKey);
    const request = pool.request();
    request.input("tableName", sql.NVarChar(128), this.tableName);
    request.input("partitionKey", sql.NVarChar(128), partitionKey);
    request.input("rowKey", sql.NVarChar(256), rowKey);
    request.input("entityJson", sql.NVarChar(sql.MAX), JSON.stringify(payload));
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
  }

  async deleteEntity(partitionKey, rowKey) {
    const pool = await this.resolvePoolForPartitionKey(partitionKey);
    const request = pool.request();
    request.input("tableName", sql.NVarChar(128), this.tableName);
    request.input("partitionKey", sql.NVarChar(128), asString(partitionKey));
    request.input("rowKey", sql.NVarChar(256), asString(rowKey));
    await request.query(`
DELETE FROM dbo.${SQL_ENTITY_TABLE}
WHERE table_name = @tableName
  AND partition_key = @partitionKey
  AND row_key = @rowKey
    `);
  }

  async *_iterEntities(filter) {
    const rawFilter = asString(filter);
    const ast = rawFilter ? parseFilter(rawFilter) : null;
    const partitionCandidates = extractPartitionKeysFromAst(ast);
    const pools = await this.resolvePoolsForList(partitionCandidates);
    const seen = new Set();

    for (const pool of pools) {
      const request = pool.request();
      request.input("tableName", sql.NVarChar(128), this.tableName);
      const result = await request.query(`
SELECT partition_key, row_key, entity_json, updated_at
FROM dbo.${SQL_ENTITY_TABLE}
WHERE table_name = @tableName
      `);
      const entities = (result.recordset || []).map(buildEntity);
      for (const entity of entities) {
        if (ast && !evalFilterAst(ast, entity)) continue;
        const key = `${asString(entity.partitionKey)}\t${asString(entity.rowKey)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        yield entity;
      }
    }
  }

  listEntities(options = {}) {
    const filter =
      asString(options && options.queryOptions && options.queryOptions.filter) ||
      asString(options && options.filter);
    return this._iterEntities(filter);
  }
}

class TableClientProxy {
  static fromConnectionString(connectionString, tableName) {
    if (shouldUseSqlBackend()) return SqlEntityTableClient.fromConnectionString(connectionString, tableName);
    return AzureTableClient.fromConnectionString(connectionString, tableName);
  }
}

module.exports = {
  TableClient: TableClientProxy,
  isSqlBackendEnabled: shouldUseSqlBackend,
  ensureTenantSqlDatabase,
  getTenantSqlDatabase: getTenantMappedDatabaseName,
  listTenantSqlDatabases: listTenantMappedDatabases,
  buildTenantSqlDatabaseName: buildTenantDatabaseName,
  sqlCatalogDatabaseName: catalogDatabaseName,
  _internals: {
    asString,
    toBool,
    sanitizeTenantId,
    sanitizeDatabaseName,
    tenantDbPrefix,
    buildTenantDatabaseName,
    extractConnectionStringField,
    getConnectionStringDatabase,
    setConnectionStringDatabase,
    cloneSqlConfigWithDatabase,
    catalogDatabaseName
  }
};
