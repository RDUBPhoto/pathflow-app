import ScheduleComponent from './schedule.component';

describe('appointment vehicle details', () => {
  function calendar() {
    const component = Object.create(ScheduleComponent.prototype) as any;
    component.customerForSchedule = () => ({ name: 'Returning Customer', vehicleYear: '2013', vehicleMake: 'Ford', vehicleModel: 'Raptor' });
    component.businessDisplayName = () => 'Shop';
    component.businessLocation = () => 'Shop address';
    component.shopTimeZone = () => 'America/Chicago';
    return component;
  }

  it('uses the job vehicle in shared calendar links and appointment emails', () => {
    const component = calendar();
    const appointment = { start: '2026-11-23T09:00:00', end: '2026-11-23T11:00:00', vehicle: '2021 Jeep Wrangler' };
    const google = new URL(component.googleCalendarUrl(appointment));
    const outlook = new URL(component.outlookCalendarUrl(appointment));
    expect(google.searchParams.get('details')).toContain('2021 Jeep Wrangler');
    expect(outlook.searchParams.get('body')).toContain('2021 Jeep Wrangler');
    const email = component.appointmentEmailHtml('Appointment confirmed', appointment, '');
    expect(email).toContain('2021 Jeep Wrangler');
    expect(email).not.toContain('2013 Ford Raptor');
  });

  it('keeps the primary vehicle fallback for older appointments without a vehicle snapshot', () => {
    const component = calendar();
    expect(component.calendarDetails({ start: '2026-11-23T09:00:00', end: '2026-11-23T11:00:00' })).toContain('2013 Ford Raptor');
  });
});
