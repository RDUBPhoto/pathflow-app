// api/customers/index.js
const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const TABLE = "customers";
const PARTITION = "main";

function toStr(v) { return v == null ? "" : String(v); }
function pick(b, k) { return toStr(b[k]).trim(); }
function setIfPresent(target, body, key) { if (Object.prototype.hasOwnProperty.call(body, key)) target[key] = pick(body, key); }

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  if (method === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = TableClient.fromConnectionString(conn, TABLE);
    try { await client.createTable(); } catch (_) {}

    if (method === "GET") {
      const out = [];
      const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
      for await (const e of iter) {
        out.push({
          id: e.rowKey,
          name: toStr(e.name),
          firstName: toStr(e.firstName),
          lastName: toStr(e.lastName),
          phone: toStr(e.phone),
          email: toStr(e.email),
          address: toStr(e.address),
          vin: toStr(e.vin),
          vehicleMake: toStr(e.vehicleMake),
          vehicleModel: toStr(e.vehicleModel),
          vehicleYear: toStr(e.vehicleYear),
          vehicleTrim: toStr(e.vehicleTrim),
          vehicleDoors: toStr(e.vehicleDoors),
          bedLength: toStr(e.bedLength),
          cabType: toStr(e.cabType),
          engineModel: toStr(e.engineModel),
          engineCylinders: toStr(e.engineCylinders),
          transmissionStyle: toStr(e.transmissionStyle),
          vehicleColor: toStr(e.vehicleColor),
          notes: toStr(e.notes),
          createdAt: toStr(e.createdAt),
          updatedAt: toStr(e.updatedAt)
        });
      }
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST") {
      const b = req.body || {};
      const op = String(b.op || "").toLowerCase();
      const id = toStr(b.id);

      if (op === "delete" && id) {
        await client.deleteEntity(PARTITION, id);
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
        return;
      }

      const name = pick(b, "name");
      const phone = pick(b, "phone");
      const email = pick(b, "email");

      if (!id && !name) {
        context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "name required" } };
        return;
      }

      if (!id) {
        const rowKey = randomUUID();
        const createdAt = toStr(b.createdAt) || new Date().toISOString();
        const entity = {
          partitionKey: PARTITION,
          rowKey,
          name,
          firstName: pick(b, "firstName"),
          lastName: pick(b, "lastName"),
          phone,
          email,
          address: pick(b, "address"),
          vin: pick(b, "vin"),
          vehicleMake: pick(b, "vehicleMake"),
          vehicleModel: pick(b, "vehicleModel"),
          vehicleYear: pick(b, "vehicleYear"),
          vehicleTrim: pick(b, "vehicleTrim"),
          vehicleDoors: pick(b, "vehicleDoors"),
          bedLength: pick(b, "bedLength"),
          cabType: pick(b, "cabType"),
          engineModel: pick(b, "engineModel"),
          engineCylinders: pick(b, "engineCylinders"),
          transmissionStyle: pick(b, "transmissionStyle"),
          vehicleColor: pick(b, "vehicleColor"),
          notes: pick(b, "notes"),
          createdAt,
          updatedAt: createdAt
        };
        await client.upsertEntity(entity, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      } else {
        const patch = { partitionKey: PARTITION, rowKey: id };
        if (name) patch.name = name;
        setIfPresent(patch, b, "firstName");
        setIfPresent(patch, b, "lastName");
        if (phone || Object.prototype.hasOwnProperty.call(b, "phone")) patch.phone = phone;
        if (email || Object.prototype.hasOwnProperty.call(b, "email")) patch.email = email;
        setIfPresent(patch, b, "address");
        setIfPresent(patch, b, "vin");
        setIfPresent(patch, b, "vehicleMake");
        setIfPresent(patch, b, "vehicleModel");
        setIfPresent(patch, b, "vehicleYear");
        setIfPresent(patch, b, "vehicleTrim");
        setIfPresent(patch, b, "vehicleDoors");
        setIfPresent(patch, b, "bedLength");
        setIfPresent(patch, b, "cabType");
        setIfPresent(patch, b, "engineModel");
        setIfPresent(patch, b, "engineCylinders");
        setIfPresent(patch, b, "transmissionStyle");
        setIfPresent(patch, b, "vehicleColor");
        setIfPresent(patch, b, "notes");
        setIfPresent(patch, b, "createdAt");
        patch.updatedAt = new Date().toISOString();

        await client.upsertEntity(patch, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id } };
        return;
      }
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String((err && err.message) || err) } };
  }
};
