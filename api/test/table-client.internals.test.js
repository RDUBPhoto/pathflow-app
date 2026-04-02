const test = require("node:test");
const assert = require("node:assert/strict");

const tableClientModule = require("../_shared/table-client");

const {
  sanitizeTenantId,
  sanitizeDatabaseName,
  tenantDbPrefix,
  buildTenantDatabaseName,
  extractConnectionStringField,
  getConnectionStringDatabase,
  setConnectionStringDatabase,
  cloneSqlConfigWithDatabase,
  catalogDatabaseName
} = tableClientModule._internals;

test("sanitizeTenantId normalizes and strips unsupported characters", () => {
  assert.equal(sanitizeTenantId("  Exodus 4x4 !!!  "), "exodus-4x4");
  assert.equal(sanitizeTenantId("My:Tenant_Name"), "my:tenant_name");
  assert.equal(sanitizeTenantId(""), "");
});

test("sanitizeDatabaseName normalizes to sql-safe name", () => {
  assert.equal(sanitizeDatabaseName(" Pathflow App::Prod "), "pathflow_app_prod");
  assert.equal(sanitizeDatabaseName("___bad__"), "bad");
  assert.equal(sanitizeDatabaseName(""), "");
});

test("tenantDbPrefix uses env override when present", () => {
  const original = process.env.SQL_TENANT_DB_PREFIX;
  process.env.SQL_TENANT_DB_PREFIX = "Pathflow Tenants PROD";
  assert.equal(tenantDbPrefix(), "pathflow_tenants_prod");
  if (original === undefined) delete process.env.SQL_TENANT_DB_PREFIX;
  else process.env.SQL_TENANT_DB_PREFIX = original;
});

test("buildTenantDatabaseName creates bounded default db name", () => {
  const original = process.env.SQL_TENANT_DB_PREFIX;
  delete process.env.SQL_TENANT_DB_PREFIX;
  const dbName = buildTenantDatabaseName("exodus-4x4");
  assert.equal(dbName, "pathflow_tenant_exodus_4x4");
  assert.ok(dbName.length <= 120);
  if (original !== undefined) process.env.SQL_TENANT_DB_PREFIX = original;
});

test("connection string field helpers read and rewrite catalog/database", () => {
  const base = "Server=tcp:example.database.windows.net,1433;Initial Catalog=old_db;Encrypt=True;";
  assert.equal(extractConnectionStringField(base, "Initial\\s+Catalog"), "old_db");
  assert.equal(getConnectionStringDatabase(base), "old_db");
  assert.equal(
    setConnectionStringDatabase(base, "new_db"),
    "Server=tcp:example.database.windows.net,1433;Initial Catalog=new_db;Encrypt=True;"
  );

  const dbOnly = "Server=tcp:example.database.windows.net,1433;Database=old_db;Encrypt=True;";
  assert.equal(getConnectionStringDatabase(dbOnly), "old_db");
  assert.equal(
    setConnectionStringDatabase(dbOnly, "new_db"),
    "Server=tcp:example.database.windows.net,1433;Database=new_db;Encrypt=True;"
  );
});

test("cloneSqlConfigWithDatabase supports both object and connection string inputs", () => {
  const objectConfig = { server: "s", database: "old", user: "u", password: "p" };
  assert.deepEqual(cloneSqlConfigWithDatabase(objectConfig, "next"), {
    server: "s",
    database: "next",
    user: "u",
    password: "p"
  });

  const conn = "Server=tcp:example.database.windows.net,1433;Database=old;Encrypt=True;";
  assert.equal(
    cloneSqlConfigWithDatabase(conn, "next"),
    "Server=tcp:example.database.windows.net,1433;Database=next;Encrypt=True;"
  );
});

test("catalogDatabaseName prefers explicit catalog env override", () => {
  const originalCatalog = process.env.SQL_CATALOG_DATABASE;
  const originalServer = process.env.SQL_SERVER;
  const originalDatabase = process.env.SQL_DATABASE;
  const originalUser = process.env.SQL_USER;
  const originalPassword = process.env.SQL_PASSWORD;

  process.env.SQL_CATALOG_DATABASE = "pathflow_catalog";
  process.env.SQL_SERVER = "example.database.windows.net";
  process.env.SQL_DATABASE = "ignored_db";
  process.env.SQL_USER = "user";
  process.env.SQL_PASSWORD = "password";

  assert.equal(catalogDatabaseName(), "pathflow_catalog");

  if (originalCatalog === undefined) delete process.env.SQL_CATALOG_DATABASE;
  else process.env.SQL_CATALOG_DATABASE = originalCatalog;
  if (originalServer === undefined) delete process.env.SQL_SERVER;
  else process.env.SQL_SERVER = originalServer;
  if (originalDatabase === undefined) delete process.env.SQL_DATABASE;
  else process.env.SQL_DATABASE = originalDatabase;
  if (originalUser === undefined) delete process.env.SQL_USER;
  else process.env.SQL_USER = originalUser;
  if (originalPassword === undefined) delete process.env.SQL_PASSWORD;
  else process.env.SQL_PASSWORD = originalPassword;
});
