import { CanDeactivateFn } from '@angular/router';

type HasUnsavedGuard = {
  canDeactivate: () => boolean;
};

export const customerProfileUnsavedGuard: CanDeactivateFn<HasUnsavedGuard> = component =>
  component.canDeactivate();
