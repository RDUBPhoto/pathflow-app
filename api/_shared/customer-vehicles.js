const { createHash, randomUUID } = require("node:crypto");

const VEHICLE_FIELDS = ["vin", "vehicleYear", "vehicleMake", "vehicleModel", "vehicleTrim", "vehicleDoors",
  "bedLength", "cabType", "engineModel", "engineCylinders", "transmissionStyle", "boltPattern", "rearBoltPattern",
  "pcd", "rearPcd", "centreBore", "wheelFasteners", "wheelTorque", "frontTireSize", "rearTireSize",
  "frontRimSize", "rearRimSize", "vehicleColor"];
const text = value => String(value ?? "").trim();
function fields(input = {}) {
  input = input && typeof input === "object" ? input : {};
  return Object.fromEntries(VEHICLE_FIELDS.map(key => [key, key === "vin"
    ? text(input[key]).toUpperCase().replace(/\s/g, "") : text(input[key])]));
}
function hasVehicle(input) { return VEHICLE_FIELDS.some(key => !!text(input?.[key])); }
function identity(input) {
  return [input.vehicleYear, input.vehicleMake, input.vehicleModel].map(value => text(value).toLowerCase()).join("|");
}
function normalizeVehicle(input, fallbackId) {
  const value = fields(input);
  if (!hasVehicle(value)) return null;
  return { id: text(input?.id).slice(0, 120) || fallbackId || "vehicle-" + createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24), ...value };
}
function readVehicles(customer = {}) {
  let source = customer.vehicles;
  if (!Array.isArray(source)) {
    try { source = JSON.parse(customer.vehiclesJson || "[]"); } catch { source = []; }
  }
  const list = [];
  for (const input of Array.isArray(source) ? source : []) {
    const vehicle = normalizeVehicle(input);
    if (!vehicle) continue;
    const existing = list.find(item => item.id === vehicle.id || (vehicle.vin && item.vin === vehicle.vin));
    if (existing) {
      for (const key of VEHICLE_FIELDS) if (!existing[key] && vehicle[key]) existing[key] = vehicle[key];
    } else list.push(vehicle);
  }
  if (!list.length && !Array.isArray(customer.vehicles) && !text(customer.vehiclesJson)) {
    const legacy = normalizeVehicle(customer, "legacy-" + text(customer.id || customer.rowKey || "vehicle"));
    if (legacy) list.push(legacy);
  }
  return list;
}
function storedVehicles(vehicles, primaryId) {
  if (Buffer.byteLength(JSON.stringify(vehicles), "utf8") > 60000) {
    throw Object.assign(new Error("The saved vehicle list is too large. Shorten the vehicle details and try again."), { statusCode: 400 });
  }
  const primary = vehicles.find(item => item.id === primaryId) || vehicles[0];
  return { vehiclesJson: JSON.stringify(vehicles), primaryVehicleId: primary?.id || "", ...fields(primary) };
}
function updateVehicles(existing = {}, body = {}) {
  if (Object.hasOwn(body, "vehicles")) {
    if (!Array.isArray(body.vehicles)) throw Object.assign(new Error("Vehicles must be a list."), { statusCode: 400 });
    const list = readVehicles({ vehicles: body.vehicles });
    return storedVehicles(list, text(body.primaryVehicleId || existing.primaryVehicleId));
  }
  const list = readVehicles(existing);
  const changed = VEHICLE_FIELDS.filter(key => Object.hasOwn(body, key));
  if (!changed.length && !Object.hasOwn(body, "primaryVehicleId")) return {};
  const primary = list.find(item => item.id === existing.primaryVehicleId) || list[0];
  const incoming = { ...(primary || {}), ...Object.fromEntries(changed.map(key => [key, body[key]])) };
  const newVin = text(body.vin).toUpperCase();
  if (newVin && primary?.vin && newVin !== primary.vin) return appendVehicle(existing, body).patch;
  if (primary) {
    const updated = normalizeVehicle(incoming, primary.id);
    list.splice(list.indexOf(primary), 1, ...(updated ? [updated] : []));
  } else {
    const added = normalizeVehicle(incoming, "legacy-" + text(existing.id || existing.rowKey || "vehicle"));
    if (added) list.push(added);
  }
  return storedVehicles(list, text(body.primaryVehicleId || existing.primaryVehicleId));
}
function appendVehicle(customer = {}, incoming = {}, preserveExisting = false) {
  const list = readVehicles(customer);
  const candidate = normalizeVehicle(incoming);
  if (!candidate) return { patch: storedVehicles(list, customer.primaryVehicleId), vehicle: null };
  let match = candidate.vin ? list.find(item => item.vin === candidate.vin) : undefined;
  const hasDescription = !!(candidate.vehicleMake || candidate.vehicleModel);
  if (!match && hasDescription) match = list.find(item => (!candidate.vin || !item.vin) && identity(item) === identity(candidate)
    && (!item.vehicleTrim || !candidate.vehicleTrim || item.vehicleTrim.toLowerCase() === candidate.vehicleTrim.toLowerCase()));
  if (match) {
    for (const key of VEHICLE_FIELDS) if (candidate[key] && (!preserveExisting || !match[key])) match[key] = candidate[key];
  } else {
    match = { ...candidate, id: text(incoming.id) || "vehicle-" + randomUUID() };
    list.push(match);
  }
  return { patch: storedVehicles(list, customer.primaryVehicleId), vehicle: match };
}
function mergeVehicles(target, source) {
  let combined = { ...target, ...storedVehicles(readVehicles(target), target.primaryVehicleId) };
  for (const vehicle of readVehicles(source)) combined = { ...combined, ...appendVehicle(combined, vehicle, true).patch };
  return storedVehicles(readVehicles(combined), target.primaryVehicleId);
}

module.exports = { VEHICLE_FIELDS, readVehicles, storedVehicles, updateVehicles, appendVehicle, mergeVehicles };
