const { TableClient } = require('./table-client');
const { readVehicles } = require('./customer-vehicles');
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

function reading(value) {
  if (typeof value === 'string') value = value.trim();
  if (value === undefined || value === null || value === '') return undefined;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) > 9999999) {
    fail('Enter mileage as a whole number from 0 to 9,999,999, or leave it blank.');
  }
  return Number(value);
}

// Readings live on the visit itself. Customer vehicle history is derived from these
// records, so saving a customer profile cannot overwrite another visit's mileage.
async function vehicleMileagePatch(connection, tenant, existing, patch, body, actor) {
  if ((existing.mileageIn != null || existing.mileageOut != null)
    && ((has(body, 'vehicleId') && body.vehicleId !== existing.vehicleId)
      || (body.customerId && body.customerId !== existing.customerId))) {
    fail('Mileage in and out must belong to the same customer vehicle.');
  }
  const mileageIn = has(body, 'mileageIn') ? reading(body.mileageIn) : undefined;
  const mileageOut = has(body, 'mileageOut') ? reading(body.mileageOut) : undefined;
  if (mileageIn === undefined && mileageOut === undefined) return {};
  if (mileageIn !== undefined && (!Number.isFinite(Date.parse(patch.checkedInAt)) || existing.checkedInAt)) fail('Record mileage in when checking in the vehicle.');
  if (mileageOut !== undefined && !Number.isFinite(Date.parse(patch.completedAt))) fail('Record mileage out when completing the job.');
  const incoming = mileageIn ?? existing.mileageIn;
  if (mileageOut !== undefined && incoming != null && mileageOut < incoming) fail('Mileage out cannot be less than mileage in.');
  const customerId = existing.customerId;
  if (!customerId || (body.customerId && body.customerId !== customerId)) fail('Select the job customer before recording mileage.');
  let customer;
  try { customer = await TableClient.fromConnectionString(connection, 'customers').getEntity(tenant, customerId); }
  catch (error) { if (error.statusCode === 404) fail('The customer is no longer available. Refresh the dashboard.'); throw error; }
  const vehicles = readVehicles(customer);
  const id = body.vehicleId || existing.vehicleId;
  const vin = String(existing.vin || '').trim().toUpperCase();
  const vehicle = id ? vehicles.find(v => v.id === id) : vin ? vehicles.find(v => v.vin === vin) : vehicles.length === 1 ? vehicles[0] : null;
  if (!vehicle) fail('Select a saved customer vehicle to record mileage, or skip mileage.');
  if (existing.vehicleId && existing.vehicleId !== vehicle.id && (existing.mileageIn != null || existing.mileageOut != null)) {
    fail('Mileage in and out must belong to the same vehicle.');
  }
  const result = { vehicleId: vehicle.id };
  for (const [field,value] of [['mileageIn',mileageIn],['mileageOut',mileageOut]]) {
    if (value === undefined) continue;
    result[field] = value;
    result[field + 'RecordedAt'] = patch.updatedAt;
    result[field + 'RecordedBy'] = String(actor.email || actor.userId || '');
  }
  return result;
}

module.exports = { vehicleMileagePatch, reading };
