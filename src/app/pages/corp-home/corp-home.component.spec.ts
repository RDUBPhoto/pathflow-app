import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../../auth/auth.service';
import CorpHomeComponent from './corp-home.component';

describe('CorpHomeComponent', () => {
  let authenticated = false;

  beforeEach(async () => {
    authenticated = false;
    await TestBed.configureTestingModule({
      imports: [CorpHomeComponent],
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            isAuthenticated: () => authenticated
          }
        }
      ]
    }).compileComponents();
  });

  it('uses SPA navigation for anonymous login', () => {
    const fixture = TestBed.createComponent(CorpHomeComponent);
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigateByUrl').and.resolveTo(true);

    fixture.componentInstance.openLogin();

    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('uses SPA navigation for authenticated dashboard access', () => {
    authenticated = true;
    const fixture = TestBed.createComponent(CorpHomeComponent);
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigateByUrl').and.resolveTo(true);

    fixture.componentInstance.openLogin();

    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });
});
