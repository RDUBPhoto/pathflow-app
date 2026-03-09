import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { IonContent } from '@ionic/angular/standalone';

@Component({
  selector: 'app-privacy-policy',
  standalone: true,
  imports: [CommonModule, IonContent],
  templateUrl: './privacy-policy.component.html',
  styleUrls: ['./privacy-policy.component.scss']
})
export default class PrivacyPolicyComponent {}
