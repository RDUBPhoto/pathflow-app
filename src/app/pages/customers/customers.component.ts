import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonHeader, IonToolbar, IonTitle, IonContent } from '@ionic/angular/standalone';

@Component({
  selector: 'app-customers',
  standalone: true,
  imports: [CommonModule, IonHeader, IonToolbar, IonTitle, IonContent],
  templateUrl: './customers.component.html',
  styleUrls: ['./customers.component.scss']
})
export default class CustomersComponent {}
