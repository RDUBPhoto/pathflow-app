import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.bootstrap();
  if (auth.isAuthenticated()) {
    return true;
  }

  return router.createUrlTree(['/login'], {
    queryParams: { redirect: state.url }
  });
};

export const roleGuard: CanActivateFn = async (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.bootstrap();

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login'], {
      queryParams: { redirect: state.url }
    });
  }

  const roles = (route.data?.['roles'] as string[] | undefined) || [];
  if (!roles.length || roles.some(role => auth.hasRole(role))) {
    return true;
  }

  return router.createUrlTree(['/forbidden']);
};

export const registeredGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.bootstrap();

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login'], {
      queryParams: { redirect: state.url }
    });
  }

  if (auth.needsRegistration()) {
    return router.createUrlTree(['/register'], {
      queryParams: { redirect: state.url }
    });
  }

  return true;
};

export const registrationGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.bootstrap();

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login'], {
      queryParams: { redirect: state.url }
    });
  }

  if (!auth.needsRegistration()) {
    return router.createUrlTree(['/dashboard']);
  }

  return true;
};
