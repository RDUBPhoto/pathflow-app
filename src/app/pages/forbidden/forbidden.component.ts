import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { RouterLink } from '@angular/router';
import { addIcons } from 'ionicons';
import { lockClosedOutline } from 'ionicons/icons';
import { AuthService } from '../../auth/auth.service';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';

@Component({
  selector: 'app-forbidden',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonButton,
    IonIcon,
    PageBackButtonComponent,
    UserMenuComponent
  ],
  templateUrl: './forbidden.component.html',
  styleUrls: ['./forbidden.component.scss']
})
export default class ForbiddenComponent {
  readonly auth = inject(AuthService);

  constructor() {
    addIcons({
      'lock-closed-outline': lockClosedOutline
    });
  }

  signOut(): void {
    this.auth.signOut('/login');
  }
}
