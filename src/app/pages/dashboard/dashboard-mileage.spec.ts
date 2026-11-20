import { signal } from '@angular/core';
import DashboardComponent from './dashboard.component';

describe('vehicle mileage prompts', () => {
  function board() {
    const component = Object.create(DashboardComponent.prototype) as any;
    const vehicle = {id:'vehicle-a',vehicleMake:'Ford',vehicleModel:'Raptor'};
    Object.assign(component, {
      mileagePrompt:signal(null),mileageValue:signal(''),mileageVehicleId:signal(''),mileageError:signal(''),
      mileageVehicles:() => [vehicle],customersMap:() => ({customer:{vehicles:[vehicle]}}),
      vehicleForWorkItem:() => vehicle,status:signal(''),
      inProgressLaneId:() => 'progress',laneStageKey:() => 'scheduled',hasCalendarEventForItem:() => true,
      performCheckIn:jasmine.createSpy('checkIn')
    });
    return component;
  }
  const item = {id:'visit-1',customerId:'customer',vehicleId:'vehicle-a',laneId:'scheduled'};

  it('defers check-in until the optional prompt is confirmed and stores zero correctly', () => {
    const component = board();
    component.checkInCard(item,{id:'scheduled'});
    expect(component.mileagePrompt().phase).toBe('in');
    expect(component.performCheckIn).not.toHaveBeenCalled();
    component.mileageValue.set('0'); component.confirmMileage();
    expect(component.performCheckIn).toHaveBeenCalledOnceWith(item,'progress',{mileageIn:0,vehicleId:'vehicle-a'});
    expect(component.mileagePrompt()).toBeNull();
  });

  it('closing the prompt cancels and skipping continues without inventing a zero reading', () => {
    const component = board();
    component.checkInCard(item,{id:'scheduled'}); component.closeMileagePrompt();
    expect(component.performCheckIn).not.toHaveBeenCalled();
    component.checkInCard(item,{id:'scheduled'}); component.mileageValue.set('bad input'); component.confirmMileage(true);
    expect(component.performCheckIn).toHaveBeenCalledOnceWith(item,'progress',{});
  });

  it('keeps the completion prompt open for invalid readings and prevents mileage out below mileage in', () => {
    const component = board(), confirm = jasmine.createSpy('complete');
    component.requestMileage({...item,mileageIn:12000},'out',confirm);
    for (const value of ['-1','12000.5','11999']) {
      component.mileageValue.set(value); component.confirmMileage();
      expect(component.mileageError()).toBeTruthy(); expect(confirm).not.toHaveBeenCalled();
    }
    component.mileageValue.set('12005'); component.confirmMileage();
    expect(confirm).toHaveBeenCalledOnceWith({mileageOut:12005,vehicleId:'vehicle-a'});
  });

  it('requires a valid vehicle only when saving a reading', () => {
    const component = board(), confirm = jasmine.createSpy('confirm');
    component.requestMileage(item,'in',confirm); component.mileageVehicleId.set('another-customer-vehicle');
    component.mileageValue.set('100'); component.confirmMileage();
    expect(confirm).not.toHaveBeenCalled(); expect(component.mileageError()).toContain('saved vehicle');
    component.confirmMileage(true); expect(confirm).toHaveBeenCalledOnceWith({});
  });
});
