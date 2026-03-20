import { TestBed } from '@angular/core/testing';
import AppComponent from './app.component';
import { AuthService } from './auth/auth.service';
import { ThemeService } from './services/theme.service';
import { provideRouter } from '@angular/router';

describe('AppComponent', () => {
  beforeEach(async () => {
    const authStub = {
      isAuthenticated: () => false,
      signOut: jasmine.createSpy('signOut')
    } as unknown as AuthService;

    const themeStub = {} as ThemeService;

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authStub },
        { provide: ThemeService, useValue: themeStub }
      ]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});
