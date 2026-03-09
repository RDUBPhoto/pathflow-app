import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonButton, IonContent } from '@ionic/angular/standalone';

@Component({
  selector: 'app-corp-home',
  standalone: true,
  imports: [CommonModule, RouterLink, IonContent, IonButton],
  templateUrl: './corp-home.component.html',
  styleUrls: ['./corp-home.component.scss']
})
export default class CorpHomeComponent {}
