import { TestBed } from '@angular/core/testing';
import { StartupTelemetryService } from '../services/startup-telemetry.service';
import { AuthService } from './auth.service';

describe('AuthService startup', () => {
  let service: AuthService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        AuthService,
        {
          provide: StartupTelemetryService,
          useValue: {
            now: () => 0,
            mark: () => undefined,
            trackDuration: () => 0
          }
        }
      ]
    }).compileComponents();
    service = TestBed.inject(AuthService);
    await service.bootstrap();
  });

  it('starts auth config and access-state requests concurrently', async () => {
    (service as any).shouldPreferLocalAuth = false;
    let resolveConfig!: () => void;
    let resolveAccess!: (value: any) => void;
    const configPending = new Promise<void>(resolve => { resolveConfig = resolve; });
    const accessPending = new Promise<any>(resolve => { resolveAccess = resolve; });
    const configSpy = spyOn<any>(service as any, 'hydrateRuntimeAuthConfig').and.returnValue(configPending);
    const accessSpy = spyOn<any>(service as any, 'fetchAccessState').and.returnValue(accessPending);
    const hydrateSpy = spyOn<any>(service as any, 'hydrateAuthState').and.resolveTo();

    const bootstrap = service.bootstrap(true);

    expect(configSpy).toHaveBeenCalled();
    expect(accessSpy).toHaveBeenCalled();
    expect(hydrateSpy).not.toHaveBeenCalled();

    const access = { principal: null, roles: [], state: {} };
    resolveAccess(access);
    resolveConfig();
    await bootstrap;

    expect(hydrateSpy).toHaveBeenCalledWith(access);
  });

  it('ignores a stale bootstrap that finishes after a newer session was checked', async () => {
    (service as any).shouldPreferLocalAuth = false;
    let resolveOlder!: (value: any) => void;
    const pending = new Promise<any>(resolve => { resolveOlder = resolve; });
    spyOn<any>(service, 'hydrateRuntimeAuthConfig').and.resolveTo();
    spyOn<any>(service, 'fetchAccessState').and.returnValues(pending, Promise.resolve({ principal: null }));
    const hydrate = spyOn<any>(service, 'hydrateAuthState');
    const older = service.bootstrap(true);
    await service.bootstrap(true);
    resolveOlder({ principal: { email: 'stale@example.test' } });
    await older;
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledWith({ principal: null });
  });

  it('preserves current state when the session check is temporarily unavailable', async () => {
    (service as any).shouldPreferLocalAuth = false;
    const previous = { id: 'staff', email: 'staff@example.test', displayName: 'Staff', roles: ['authenticated'] };
    (service as any).stateSignal.set({ initialized: true, loading: false, source: 'session', user: previous });
    spyOn<any>(service, 'hydrateRuntimeAuthConfig').and.resolveTo();
    spyOn<any>(service, 'fetchAccessState').and.rejectWith(new Error('Temporary outage'));
    await service.bootstrap(true);
    expect(service.user()).toBe(previous as any);
    expect(service.sessionCheckFailed()).toBeTrue();
    expect(service.loading()).toBeFalse();
  });
});
