import { Component, inject } from '@angular/core';
import {
  IonApp, IonRouterOutlet
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { settingsOutline } from 'ionicons/icons';
import { ThemeService } from './services/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    IonApp, IonRouterOutlet
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export default class AppComponent {
  private readonly theme = inject(ThemeService);

  constructor() {
    // Keep app theme initialized at bootstrap.
    void this.theme;

    addIcons({
      'settings-outline': settingsOutline
    });
  }
}
