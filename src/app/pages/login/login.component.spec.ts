import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import LoginComponent from './login.component';

describe('LoginComponent', () => {
  const initialized = signal(false);
  const loading = signal(true);
  const email = 'remembered@example.com';

  beforeEach(async () => {
    localStorage.setItem('pathflow.auth.passkey.pref', JSON.stringify({ [email]: true }));
    localStorage.setItem('pathflow.auth.passkey.last-email', email);
    initialized.set(false);
    loading.set(true);

    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of(convertToParamMap({}))
          }
        },
        {
          provide: AuthService,
          useValue: {
            initialized,
            loading,
            isAuthenticated: () => false,
            sessionCheckFailed: () => false,
            needsRegistration: () => false,
            isAccessLocked: () => false,
            isLocalPasswordAuthEnabled: () => true,
            isProviderEnabled: () => false,
            isHostedEmailEnabled: () => false,
            hostedEmailProvider: () => '',
            isPasskeySupported: () => true,
            hasPasskeyForEmail: () => true
          }
        }
      ]
    }).compileComponents();
  });

  afterEach(() => {
    localStorage.removeItem('pathflow.auth.passkey.pref');
    localStorage.removeItem('pathflow.auth.passkey.last-email');
  });

  it('shows the remembered biometric prompt while auth is still loading', () => {
    const fixture = TestBed.createComponent(LoginComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.localLoginEmail).toBe(email);
    expect(fixture.componentInstance.biometricsPromptVisible()).toBeTrue();
    const biometricLogin = fixture.nativeElement.querySelector('.biometric-prompt-overlay .prompt-actions button');
    expect(biometricLogin).not.toBeNull();
    expect(biometricLogin.disabled).toBeTrue();
  });
});
