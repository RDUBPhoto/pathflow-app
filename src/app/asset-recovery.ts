import { NavigationError, Router } from '@angular/router';
import { normalizeAuthRedirect } from './auth/auth-redirect';

declare global {
  interface Window {
    pathflowAssetRecovery?: { recover(error: unknown, destination: string, automatic: boolean): boolean };
  }
}

export function recoverNavigationAssets(event: NavigationError, router: Router): void {
  const destination = normalizeAuthRedirect(event.url, router.url);
  const currentPath = router.url.split(/[?#]/)[0];
  const destinationPath = destination.split(/[?#]/)[0];
  // Public authentication and initial page loads have no workspace edits to preserve.
  const automatic = !router.lastSuccessfulNavigation || destinationPath === '/login'
    || currentPath === '/' || currentPath === '/login';
  window.pathflowAssetRecovery?.recover(event.error, destination, automatic);
}
