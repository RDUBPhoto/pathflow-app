import { Component, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonItem, IonLabel, IonInput, IonButton, IonSpinner
} from '@ionic/angular/standalone';
import { FormsModule } from '@angular/forms';
import {
  CdkDropList, CdkDropListGroup, CdkDrag, CdkDragDrop,
  moveItemInArray, transferArrayItem
} from '@angular/cdk/drag-drop';
import { LanesApi, Lane } from '../../services/lanes-api.service';
import { WorkItemsApi, WorkItem } from '../../services/workitems-api.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonItem, IonLabel, IonInput, IonButton, IonSpinner,
    CdkDropList, CdkDropListGroup, CdkDrag
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export default class DashboardComponent {
  lanes = signal<Lane[]>([]);
  laneIds = computed(() => this.lanes().map(l => l.id));
  items = signal<Record<string, WorkItem[]>>({});
  loading = signal(false);
  status = signal('');
  newLane = signal('');
  newCardTitle = signal<Record<string, string>>({});

  constructor(private lanesApi: LanesApi, private itemsApi: WorkItemsApi) {
    this.loadAll();
  }

  loadAll() {
    this.loading.set(true);
    this.lanesApi.list().subscribe({
      next: lanes => {
        this.lanes.set(lanes);
        this.itemsApi.list().subscribe({
          next: rows => {
            const map: Record<string, WorkItem[]> = {};
            for (const l of lanes) map[l.id] = [];
            for (const r of rows) {
              if (!map[r.laneId]) map[r.laneId] = [];
              map[r.laneId].push(r);
            }
            for (const id of Object.keys(map)) map[id].sort((a,b) => (a.sort ?? 0) - (b.sort ?? 0));
            this.items.set(map);
            this.loading.set(false);
          },
          error: _ => { this.status.set('Load items error'); this.loading.set(false); }
        });
      },
      error: _ => { this.status.set('Load lanes error'); this.loading.set(false); }
    });
  }

  addLane() {
    const name = this.newLane().trim();
    if (!name) return;
    this.status.set('Saving lane');
    this.lanesApi.create(name).subscribe({
      next: _ => { this.newLane.set(''); this.loadAll(); },
      error: _ => this.status.set('Save lane error')
    });
  }

  setNewCardTitle(laneId: string, val: string) {
    const m = { ...this.newCardTitle() };
    m[laneId] = val;
    this.newCardTitle.set(m);
  }

  addCard(laneId: string) {
    const t = (this.newCardTitle()[laneId] || '').trim();
    if (!t) return;
    this.status.set('Saving card');
    this.itemsApi.create(t, laneId).subscribe({
      next: _ => {
        const m = { ...this.newCardTitle() };
        m[laneId] = '';
        this.newCardTitle.set(m);
        this.loadAll();
      },
      error: _ => this.status.set('Save card error')
    });
  }

  onLanesDrop(e: CdkDragDrop<Lane[]>) {
    const arr = [...this.lanes()];
    moveItemInArray(arr, e.previousIndex, e.currentIndex);
    this.lanes.set(arr);
    const ids = arr.map(x => x.id);
    this.lanesApi.reorder(ids).subscribe();
  }

  onCardsDrop(event: CdkDragDrop<WorkItem[]>, targetLaneId: string) {
    const map = { ...this.items() };
    const sourceId = event.previousContainer.id;
    const targetId = event.container.id;

    if (sourceId === targetId) {
      moveItemInArray(map[targetId], event.previousIndex, event.currentIndex);
      this.items.set(map);
      const ids = map[targetId].map(x => x.id);
      this.itemsApi.reorder(targetLaneId, ids).subscribe();
    } else {
      transferArrayItem(map[sourceId], map[targetId], event.previousIndex, event.currentIndex);
      this.items.set(map);
      const moved = map[targetId][event.currentIndex];
      this.itemsApi.update({ id: moved.id, laneId: targetLaneId }).subscribe({
        next: _ => {
          const idsT = map[targetId].map(x => x.id);
          const idsS = map[sourceId].map(x => x.id);
          this.itemsApi.reorder(targetLaneId, idsT).subscribe();
          this.itemsApi.reorder(sourceId, idsS).subscribe();
        }
      });
    }
  }

  trackLane(_i: number, l: Lane) { return l.id; }
  trackItem(_i: number, it: WorkItem) { return it.id; }
}
