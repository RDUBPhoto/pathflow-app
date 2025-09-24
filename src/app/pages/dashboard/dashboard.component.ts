import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonHeader, IonToolbar, IonTitle, IonContent, IonButton } from '@ionic/angular/standalone';
import { CdkDropList, CdkDrag, CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { HttpClient } from '@angular/common/http';

type Card = { id: string; name: string };

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButton,
    CdkDropList, CdkDrag
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export default class DashboardComponent {
  constructor(private http: HttpClient) {}

  lead = signal<Card[]>([{ id: '1', name: 'John – Raptor shocks' }, { id: '2', name: 'Emily – Jeep lift' }]);
  quote = signal<Card[]>([{ id: '3', name: 'Carlos – Wheel/Tire' }]);
  invoiced = signal<Card[]>([]);
  pingResult = signal<string>('');

  testPing() {
    this.pingResult.set('Testing…');
    this.http.get<{ ok: boolean; message: string }>('/api/ping').subscribe({
      next: res => this.pingResult.set(`ok=${res.ok}, message=${res.message}`),
      error: err => this.pingResult.set(`Error: ${err?.status || ''} ${err?.statusText || ''}`.trim())
    });
  }

  dropped(event: CdkDragDrop<Card[]>) {
    if (event.previousContainer === event.container) {
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
    } else {
      transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex);
    }
  }
}
