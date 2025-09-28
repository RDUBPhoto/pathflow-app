import { bootstrapApplication } from '@angular/platform-browser';
import AppComponent from './app/app.component';
import { appConfig } from './app/app.config';

import { addIcons } from 'ionicons';
import {
  settingsOutline,
  ellipsisVertical,
  reorderTwoOutline,
  reorderThreeOutline,
  linkOutline,
  alertCircleOutline
} from 'ionicons/icons';

addIcons({
  'settings-outline': settingsOutline,
  'ellipsis-vertical': ellipsisVertical,
  'reorder-two-outline': reorderTwoOutline,
  'reorder-three-outline': reorderThreeOutline,
  'link-outline': linkOutline,
  'alert-circle-outline': alertCircleOutline
});

bootstrapApplication(AppComponent, appConfig).catch(err => console.error(err));