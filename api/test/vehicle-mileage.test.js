const test = require('node:test');
const assert = require('node:assert/strict');
const { TableClient } = require('../_shared/table-client');
const { vehicleMileagePatch, reading } = require('../_shared/vehicle-mileage');
const now = '2026-11-20T14:00:00Z';
const actor = { email: 'staff@example.test' };
const first = { id:'vehicle-a', vehicleYear:'2024', vehicleMake:'Ford', vehicleModel:'Raptor' };
const second = { id:'vehicle-b', vehicleYear:'2022', vehicleMake:'Jeep', vehicleModel:'Wrangler' };
async function fixture(run) {
  const original = TableClient.fromConnectionString;
  const customer = { vehiclesJson: JSON.stringify([first, second]) };
  TableClient.fromConnectionString = () => ({ async getEntity(tenant,id) {
    assert.equal(tenant,'shop-a'); assert.equal(id,'customer-a'); return customer;
  } });
  try { await run(customer); } finally { TableClient.fromConnectionString = original; }
}
const visit = { rowKey:'job-a', customerId:'customer-a', vehicleId:'vehicle-a' };
const record = (body,existing=visit,patch={updatedAt:now,checkedInAt:now}) => vehicleMileagePatch('', 'shop-a', existing,patch,body,actor);

test('optional readings preserve zero and reject negative, fractional, nonnumeric and excessive mileage', () => {
  for (const value of [undefined,null,'','  ']) assert.equal(reading(value),undefined);
  for (const value of [0,'0',1234567,' 3456 ']) assert.equal(reading(value),Number(value));
  for (const value of [-1,1.1,'1e3','abc',{},true,NaN,Infinity,10000000]) assert.throws(() => reading(value),e => e.statusCode===400);
});

test('check-in records the reading, exact vehicle, time and staff on its own visit', () => fixture(async () => {
  assert.deepEqual(await record({mileageIn:0}),{vehicleId:'vehicle-a',mileageIn:0,mileageInRecordedAt:now,mileageInRecordedBy:actor.email});
  assert.equal(visit.mileageIn,undefined);
}));

test('completion validates mileage against this visit, not another vehicle or earlier visit', () => fixture(async () => {
  const existing = {...visit,checkedInAt:now,mileageIn:45200};
  const patch = {updatedAt:now,completedAt:now};
  const result = await record({mileageOut:45204},existing,patch);
  assert.equal(result.mileageOut,45204); assert.equal(result.vehicleId,'vehicle-a');
  await assert.rejects(record({mileageOut:45199},existing,patch),e => e.statusCode===400);
  await assert.rejects(record({mileageOut:45204,vehicleId:'vehicle-b'},existing,patch),e => e.statusCode===400);
  await assert.rejects(record({vehicleId:'vehicle-b'},existing,patch),e => e.statusCode===400);
  assert.deepEqual(await record({},existing,patch),{});
}));

test('ambiguous and invalid customer vehicles are rejected before storing a reading', () => fixture(async () => {
  await assert.rejects(record({mileageIn:1000},{...visit,vehicleId:''}),e => e.statusCode===400);
  await assert.rejects(record({mileageIn:1000,vehicleId:'other-customer-vehicle'}),e => e.statusCode===400);
  await assert.rejects(record({mileageIn:1000,customerId:'customer-b'}),e => e.statusCode===400);
  assert.equal((await record({mileageIn:1000,vehicleId:'vehicle-b'},{...visit,vehicleId:''})).vehicleId,'vehicle-b');
}));

test('a legacy single vehicle is resolved and skipped readings do not require vehicle details', () => fixture(async customer => {
  delete customer.vehiclesJson; Object.assign(customer,{rowKey:'customer-a',...first}); delete customer.id;
  assert.equal((await record({mileageIn:1000},{...visit,vehicleId:''})).vehicleId,'legacy-customer-a');
  assert.deepEqual(await record({mileageIn:''},{...visit,customerId:'',vehicleId:''}),{});
}));

test('readings require the corresponding check-in or completion transition', () => fixture(async () => {
  await assert.rejects(record({mileageIn:1000},visit,{updatedAt:now}),e => e.statusCode===400);
  await assert.rejects(record({mileageIn:1000},{...visit,checkedInAt:now}),e => e.statusCode===400);
  await assert.rejects(record({mileageOut:1000},visit,{updatedAt:now}),e => e.statusCode===400);
}));
