import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { IonContent } from '@ionic/angular/standalone';

@Component({
  selector: 'app-sms-opt-in-other',
  standalone: true,
  imports: [CommonModule, IonContent],
  templateUrl: './sms-opt-in-other.component.html',
  styleUrls: ['./sms-opt-in-other.component.scss']
})
export default class SmsOptInOtherComponent {}
