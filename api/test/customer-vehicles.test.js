const test = require('node:test');
const assert = require('node:assert/strict');
const { readVehicles, updateVehicles, appendVehicle, mergeVehicles } = require('../_shared/customer-vehicles');

const first = { rowKey: 'existing', vin: '1FTFW1R60DFA00001', vehicleYear: '2013', vehicleMake: 'Ford', vehicleModel: 'Raptor', vehicleColor: '#ffffff', wheelTorque: '150 ft-lb' };

test('an existing legacy vehicle survives adding another vehicle with separate fitment', () => {
  const added = appendVehicle(first, { vin: '1FMDE5BH0MLA00001', vehicleYear: '2021', vehicleMake: 'Ford', vehicleModel: 'Bronco', vehicleColor: '#000000' });
  const customer = { ...first, ...added.patch };
  const vehicles = readVehicles(customer);
  assert.equal(vehicles.length, 2);
  assert.equal(customer.vin, first.vin);
  assert.equal(customer.vehicleModel, 'Raptor');
  assert.equal(vehicles[0].wheelTorque, '150 ft-lb');
  assert.equal(vehicles[1].wheelTorque, '');
  assert.equal(vehicles[1].vehicleColor, '#000000');
  assert.equal(added.vehicle.id, vehicles[1].id);
});

test('the same VIN is normalized and reused while equal descriptions with distinct VINs remain separate', () => {
  let customer = { ...first, ...appendVehicle(first, { ...first, vin: '1FMDE5BH0MLA00001' }).patch };
  const vehicles = readVehicles(customer);
  assert.equal(vehicles.length, 2);
  customer = { ...customer, ...appendVehicle(customer, { vin: ' 1fmde5bh0mla00001 ', vehicleTrim: 'Wildtrak' }).patch };
  assert.equal(readVehicles(customer).length, 2);
  assert.equal(readVehicles(customer)[1].id, vehicles[1].id);
  assert.equal(readVehicles(customer)[1].vehicleTrim, 'Wildtrak');
});

test('editing and removing one saved vehicle preserves the other and can change the primary', () => {
  const customer = { ...first, ...appendVehicle(first, { vehicleYear: '2024', vehicleMake: 'Toyota', vehicleModel: 'Tacoma' }).patch };
  const vehicles = readVehicles(customer);
  const edited = vehicles.map((vehicle, index) => index ? { ...vehicle, wheelTorque: '95 ft-lb' } : vehicle);
  const updated = updateVehicles(customer, { vehicles: edited, primaryVehicleId: vehicles[1].id });
  assert.equal(updated.vehicleModel, 'Tacoma');
  assert.equal(readVehicles(updated)[0].wheelTorque, first.wheelTorque);
  assert.equal(readVehicles(updated)[1].wheelTorque, '95 ft-lb');
  const removed = updateVehicles(updated, { vehicles: [edited[0]] });
  assert.equal(readVehicles(removed).length, 1);
  assert.equal(removed.vehicleModel, 'Raptor');
  const empty = updateVehicles(removed, { vehicles: [] });
  assert.equal(empty.vin, '');
  assert.deepEqual(readVehicles(empty), []);
});

test('customer merges retain vehicles from both records, and contact-only changes leave vehicles alone', () => {
  const merged = mergeVehicles(first, { rowKey: 'other', vin: '1FMDE5BH0MLA00001', vehicleYear: '2021', vehicleModel: 'Bronco' });
  assert.equal(readVehicles(merged).length, 2);
  assert.equal(merged.vin, first.vin);
  assert.deepEqual(updateVehicles(merged, { phone: '+15125550100' }), {});
});

test('a repeated vehicle description without its trim reuses the saved vehicle', () => {
  const customer = { rowKey: 'repeat', vehicleYear: '2021', vehicleMake: 'Jeep', vehicleModel: 'Wrangler', vehicleTrim: 'Sport' };
  const added = appendVehicle(customer, { vehicleYear: '2021', vehicleMake: 'Jeep', vehicleModel: 'Wrangler' });
  assert.equal(readVehicles(added.patch).length, 1);
  assert.equal(added.vehicle.vehicleTrim, 'Sport');
});

test('merging the same vehicle keeps existing details while filling missing fields', () => {
  const merged = mergeVehicles(first, { ...first, rowKey: 'duplicate', wheelTorque: 'older value', vehicleTrim: 'SVT' });
  assert.equal(readVehicles(merged).length, 1);
  assert.equal(merged.wheelTorque, first.wheelTorque);
  assert.equal(merged.vehicleTrim, 'SVT');
});
