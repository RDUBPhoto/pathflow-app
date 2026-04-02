const { TableClient: AzureTableClient } = require("@azure/data-tables");

let sql = null;
try {
  sql = require("mssql");
} catch (_) {
  sql = null;
}

const SQL_ENTITY_TABLE = "PathflowEntities";
let sqlPoolPromise = null;
let sqlSchemaPromise = null;

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

async function getSqlPool() {
  if (!sql) {
    throw new Error("SQL backend selected but 'mssql' package is not installed in api dependencies.");
  }

  if (!sqlPoolPromise) {
    const config = sqlConfigFromEnv();
    if (!config) {
      throw new Error(
        "SQL backend selected but SQL connection is not configured. Set SQL_CONNECTION_STRING (or SQL_SERVER/SQL_DATABASE/SQL_USER/SQL_PASSWORD)."
      );
    }
    sqlPoolPromise = new sql.ConnectionPool(config).connect();
  }
  return sqlPoolPromise;
}

async function ensureSqlSchema() {
  if (!sqlSchemaPromise) {
    sqlSchemaPromise = (async () => {
      const pool = await getSqlPool();
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
    })().catch((err) => {
      sqlSchemaPromise = null;
      throw err;
    });
  }
  return sqlSchemaPromise;
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

function applyFilter(entities, filter) {
  const raw = asString(filter);
  if (!raw) return entities;
  const ast = parseFilter(raw);
  return entities.filter((entity) => evalFilterAst(ast, entity));
}

class SqlEntityTableClient {
  constructor(tableName) {
    this.tableName = asString(tableName).toLowerCase();
  }

  static fromConnectionString(_connectionString, tableName) {
    return new SqlEntityTableClient(tableName);
  }

  async createTable() {
    await ensureSqlSchema();
  }

  async getEntity(partitionKey, rowKey) {
    await ensureSqlSchema();
    const pool = await getSqlPool();
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
    await ensureSqlSchema();
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

    const pool = await getSqlPool();
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
    await ensureSqlSchema();
    const pool = await getSqlPool();
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
    await ensureSqlSchema();
    const pool = await getSqlPool();
    const request = pool.request();
    request.input("tableName", sql.NVarChar(128), this.tableName);
    const result = await request.query(`
SELECT partition_key, row_key, entity_json, updated_at
FROM dbo.${SQL_ENTITY_TABLE}
WHERE table_name = @tableName
    `);
    let entities = (result.recordset || []).map(buildEntity);
    entities = applyFilter(entities, filter);
    for (const entity of entities) yield entity;
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
  isSqlBackendEnabled: shouldUseSqlBackend
};
