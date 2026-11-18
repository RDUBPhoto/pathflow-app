import { UiIcon } from '../../ui/icons';
import { Component, inject, ChangeDetectionStrategy } from '@angular/core';

import { RouterLink } from '@angular/router';
import { AuthService } from '../../auth/auth.service';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';

@Component({
  selector: 'app-forbidden',
  standalone: true,
  imports: [
    RouterLink,
    UiIcon,
    PageBackButtonComponent,
    UserMenuComponent,
    CompanySwitcherComponent
],
  templateUrl: './forbidden.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./forbidden.component.scss']
})
export default class ForbiddenComponent {
  readonly auth = inject(AuthService);

  constructor() {
  }

  signOut(): void {
    this.auth.signOut('/');
  }
}
