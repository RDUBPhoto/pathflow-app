import { Location } from '@angular/common';
import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { IonButton, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBackOutline } from 'ionicons/icons';

@Component({
  selector: 'app-page-back-button',
  standalone: true,
  imports: [IonButton, IonIcon],
  templateUrl: './page-back-button.component.html',
  styleUrls: ['./page-back-button.component.scss']
})
export class PageBackButtonComponent {
  constructor(
    private location: Location,
    private router: Router
  ) {
    addIcons({
      'arrow-back-outline': arrowBackOutline
    });
  }

  goBack(): void {
    if (window.history.length > 1) {
      this.location.back();
      return;
    }

    void this.router.navigateByUrl('/dashboard');
  }
}
