import { UiIcon } from '../../../ui/icons';
import { Location } from '@angular/common';
import { Component, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-page-back-button',
  standalone: true,
  imports: [ UiIcon],
  templateUrl: './page-back-button.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./page-back-button.component.scss']
})
export class PageBackButtonComponent {
  constructor(
    private location: Location,
    private router: Router
  ) {
  }

  goBack(): void {
    if (window.history.length > 1) {
      this.location.back();
      return;
    }

    void this.router.navigateByUrl('/dashboard');
  }
}
