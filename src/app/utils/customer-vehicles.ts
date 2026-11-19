export const VEHICLE_FIELDS = ['vin', 'vehicleYear', 'vehicleMake', 'vehicleModel', 'vehicleTrim', 'vehicleDoors',
  'bedLength', 'cabType', 'engineModel', 'engineCylinders', 'transmissionStyle', 'boltPattern', 'rearBoltPattern',
  'pcd', 'rearPcd', 'centreBore', 'wheelFasteners', 'wheelTorque', 'frontTireSize', 'rearTireSize',
  'frontRimSize', 'rearRimSize', 'vehicleColor'] as const;

export type CustomerVehicle = { id: string } & Partial<Record<typeof VEHICLE_FIELDS[number], string>>;
type VehicleCustomer = Partial<Record<typeof VEHICLE_FIELDS[number], string>> & {
  id?: string; vehicles?: CustomerVehicle[]; primaryVehicleId?: string;
};
export function customerVehicles(customer: VehicleCustomer | null | undefined): CustomerVehicle[] {
  if (!customer) return [];
  if (Array.isArray(customer.vehicles)) return customer.vehicles.map(vehicle => ({
    id: vehicle.id, ...Object.fromEntries(VEHICLE_FIELDS.map(key => [key, vehicle[key] || '']))
  }));
  if (!VEHICLE_FIELDS.some(key => !!customer[key]?.trim())) return [];
  return [{ id: 'legacy-' + (customer.id || 'vehicle'), ...Object.fromEntries(VEHICLE_FIELDS.map(key => [key, customer[key] || ''])) }];
}
export function vehicleSummary(vehicle: Partial<CustomerVehicle> | null | undefined): string {
  return [vehicle?.vehicleYear, vehicle?.vehicleMake, vehicle?.vehicleModel, vehicle?.vehicleTrim]
    .map(value => String(value || '').trim()).filter(Boolean).join(' ');
}
