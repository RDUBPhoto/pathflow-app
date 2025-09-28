import { Component, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
  IonItem, IonLabel, IonInput, IonSpinner, IonIcon, IonModal,
  IonSelect, IonSelectOption, IonTextarea, IonToggle, IonMenu, IonList, IonPopover, IonMenuToggle, IonLoading
} from '@ionic/angular/standalone';
import { FormsModule } from '@angular/forms';
import {
  CdkDropList, CdkDropListGroup, CdkDrag, CdkDragDrop,
  moveItemInArray, transferArrayItem
} from '@angular/cdk/drag-drop';
import { LanesApi, Lane } from '../../services/lanes-api.service';
import { WorkItemsApi, WorkItem } from '../../services/workitems-api.service';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { MenuController } from '@ionic/angular';

type ColorOpt = { label: string; hex: string };

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
    IonItem, IonLabel, IonInput, IonSpinner, IonIcon, IonModal,
    IonSelect, IonSelectOption, IonTextarea, IonToggle,
    CdkDropList, CdkDropListGroup, CdkDrag, IonList, IonMenu, IonPopover, IonMenuToggle, IonLoading
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export default class DashboardComponent {
  lanes = signal<Lane[]>([]);
  laneIds = computed(() => this.lanes().map(l => l.id));
  items = signal<Record<string, WorkItem[]>>({});
  customersMap = signal<Record<string, Customer>>({});
  loading = signal(false);
  status = signal('');
  newLane = signal('');
  newCardTitle = signal<Record<string, string>>({});
  openNew = signal(false);
  ncName = signal('');
  ncPhone = signal('');
  ncEmail = signal('');
  ncVehicle = signal('');
  ncNotes = signal('');
  ncAlsoAdd = signal(true);
  ncLaneId = signal<string | null>(null);
  ncColor = signal<string>('');
  allCustomers = signal<Customer[]>([]);
  dupMatches = signal<Customer[]>([]);
  dupChecking = signal(false);
  selectedExistingId = signal<string | null>(null);
  expanded = signal<Record<string, boolean>>({});
  laneColors = signal<Record<string, string>>({});
  laneMenuOpen = signal(false);
  laneMenuEvent = signal<any>(null);
  laneMenuLaneId = signal<string | null>(null);
  renameValue = signal('');
  renameOpen = signal(false);
  laneSorts = signal<Record<string, 'manual' | 'nameAsc' | 'nameDesc' | 'vehicleAsc' | 'vehicleDesc'>>({});
  deleteOpen = signal(false);
  deleteTargetId = signal<string | null>(null);
  deleteTargetName = signal<string>('');
  deleteTargetCount = signal(0);
  cardMenuOpen = signal(false);
  cardMenuEvent = signal<any>(null);
  cardMenuItemId = signal<string | null>(null);
  editMode = signal(false);
  editCustomerId = signal<string | null>(null);
  customerDeleteOpen = signal(false);
  customerDeleteId = signal<string | null>(null);
  customerDeleteName = signal<string>('');
  cardDeleteItemId = signal<string | null>(null);


  palette: ColorOpt[] = [
    { label: 'White',  hex: '#ffffff' },
    { label: 'Black',  hex: '#000000' },
    { label: 'Silver', hex: '#c0c0c0' },
    { label: 'Gray',   hex: '#808080' },
    { label: 'Red',    hex: '#d32f2f' },
    { label: 'Blue',   hex: '#1976d2' },
    { label: 'Green',  hex: '#388e3c' },
    { label: 'Yellow', hex: '#fbc02d' },
    { label: 'Orange', hex: '#f57c00' },
    { label: 'Brown',  hex: '#795548' }
  ];

  constructor(
    private lanesApi: LanesApi,
    private itemsApi: WorkItemsApi,
    private customersApi: CustomersApi,
    private menu: MenuController,
  ) {
    this.loadLaneColors();
    this.loadAll();
    effect(() => {
      const v = this.laneColors();
      localStorage.setItem('laneColors', JSON.stringify(v));
    });
    effect(() => {
      this.ncPhone();
      this.ncEmail();
      this.allCustomers();
      this.recomputeDupMatches();
    });
  }

  async openSettings() {
    await this.menu.enable(true, 'board-settings');
    await this.menu.open('board-settings');
  }

  openLaneMenu(ev: Event, lane: Lane) {
    this.laneMenuEvent.set(ev);
    this.laneMenuLaneId.set(lane.id);
    this.renameValue.set(lane.name || '');
    this.laneMenuOpen.set(true);
  }

  closeLaneMenu() {
    this.laneMenuOpen.set(false);
  }

  openDelete(lane: Lane) {
    this.deleteTargetId.set(lane.id);
    this.deleteTargetName.set(lane.name || '');
    this.deleteTargetCount.set(this.itemsCount(lane.id));
    this.deleteOpen.set(true);
  }

  cancelDelete() {
    this.deleteOpen.set(false);
  }

  handleDeleteFromMenu() {
    const id = this.laneMenuLaneId();
    if (!id) return;
    const lane = this.lanes().find(l => l.id === id);
    if (!lane) return;
    this.laneMenuOpen.set(false);
    setTimeout(() => this.openDelete(lane), 0);
  }

  openCardMenu(ev: Event, it: WorkItem) {
    this.cardMenuEvent.set(ev);
    this.cardMenuItemId.set(it.id);
    this.cardMenuOpen.set(true);
  }
  closeCardMenu() { this.cardMenuOpen.set(false); }

  startEditFromCard() {
    const itId = this.cardMenuItemId();
    this.cardMenuOpen.set(false);
    if (!itId) return;
    let it: WorkItem | undefined;
    for (const arr of Object.values(this.items())) {
      it = (arr as WorkItem[]).find(x => x.id === itId);
      if (it) break;
    }
    if (!it) return;
    const cust = this.customersMap()[it.customerId || ''];
    if (!cust) return;
    this.editMode.set(true);
    this.editCustomerId.set(cust.id);
    this.ncName.set(cust.name || '');
    this.ncPhone.set(cust.phone || '');
    this.ncEmail.set(cust.email || '');
    this.ncVehicle.set(this.vehicleOf(it) || '');
    this.ncNotes.set(this.notesOf(it) || '');
    this.ncColor.set(this.colorOf(it) || '');
    this.ncAlsoAdd.set(false);
    this.openNew.set(true);
  }

  startDeleteFromCard() {
    const itId = this.cardMenuItemId();
    this.cardMenuOpen.set(false);
    if (!itId) return;
    let it: WorkItem | undefined;
    for (const arr of Object.values(this.items())) {
      it = (arr as WorkItem[]).find(x => x.id === itId);
      if (it) break;
    }
    if (!it) return;
    const cust = this.customersMap()[it.customerId || ''];
    if (!cust) return;
    this.customerDeleteId.set(cust.id);
    this.customerDeleteName.set(cust.name || '');
    this.cardDeleteItemId.set(it.id);
    this.customerDeleteOpen.set(true);
  }

  cancelDeleteCustomer() {
    this.customerDeleteOpen.set(false);
    this.cardDeleteItemId.set(null);
  }

  confirmDeleteCustomer() {
    const custId = this.customerDeleteId();
    const itemId = this.cardDeleteItemId();
    if (!custId) { this.customerDeleteOpen.set(false); this.cardDeleteItemId.set(null); return; }
    this.status.set('Deleting customer');
    this.customersApi.delete(custId).subscribe({
      next: () => {
        const cm = { ...this.customersMap() };
        delete cm[custId];
        this.customersMap.set(cm);
        this.allCustomers.set(this.allCustomers().filter(c => c.id !== custId));
        if (itemId) {
          this.itemsApi.delete(itemId).subscribe({
            next: () => {
              const map = { ...this.items() };
              for (const k of Object.keys(map)) map[k] = map[k].filter(w => w.id !== itemId);
              this.items.set(map);
              this.customerDeleteOpen.set(false);
              this.cardDeleteItemId.set(null);
              this.status.set('Deleted');
            },
            error: () => {
              this.customerDeleteOpen.set(false);
              this.cardDeleteItemId.set(null);
              this.status.set('Delete card error');
            }
          });
        } else {
          const map = { ...this.items() };
          for (const k of Object.keys(map)) map[k] = map[k].map(w => w.customerId === custId ? { ...w, customerId: '' } as WorkItem : w);
          this.items.set(map);
          this.customerDeleteOpen.set(false);
          this.cardDeleteItemId.set(null);
          this.status.set('Deleted');
        }
      },
      error: () => {
        this.customerDeleteOpen.set(false);
        this.cardDeleteItemId.set(null);
        this.status.set('Delete customer error');
      }
    });
  }

  confirmDelete() {
    const id = this.deleteTargetId();
    const cnt = this.deleteTargetCount();
    if (!id) { this.deleteOpen.set(false); return; }
    if (cnt > 0) { this.status.set('Lane not empty'); this.deleteOpen.set(false); return; }
    this.status.set('Deleting lane');
    this.lanesApi.delete(id).subscribe({
      next: () => { this.deleteOpen.set(false); this.loadAll(); this.status.set('Deleted'); },
      error: () => { this.deleteOpen.set(false); this.status.set('Delete lane error'); }
    });
  }

  itemsCount(laneId: string): number {
    const arr = this.items()[laneId] || [];
    return arr.length;
  }

  deleteLane(laneId: string) {
    const count = this.itemsCount(laneId);
    if (count > 0) { this.status.set('Lane not empty'); return; }
    if (!window.confirm('Delete lane?')) return;
    this.status.set('Deleting lane');
    this.lanesApi.delete(laneId).subscribe({
      next: () => { this.loadAll(); this.status.set('Deleted'); },
      error: () => this.status.set('Delete lane error')
    });
  }

  deleteMenuLane() {
    const id = this.laneMenuLaneId();
    if (!id) return;
    this.deleteLane(id);
    this.laneMenuOpen.set(false);
  }

  startRename() {
    this.renameOpen.set(true);
    this.laneMenuOpen.set(false);
  }

  saveRename() {
    const id = this.laneMenuLaneId();
    const nm = this.renameValue().trim();
    if (!id || !nm) { this.renameOpen.set(false); return; }
    this.status.set('Renaming lane');
    this.lanesApi.update(id, nm).subscribe({
      next: () => { this.renameOpen.set(false); this.loadAll(); this.status.set('Renamed'); },
      error: () => { this.renameOpen.set(false); this.status.set('Rename error'); }
    });
  }

  startColor() {
    this.status.set('Lane color');
    this.laneMenuOpen.set(false);
  }

  startSort() {
    this.status.set('Lane sort');
    this.laneMenuOpen.set(false);
  }

  loadLaneColors() {
    try {
      const raw = localStorage.getItem('laneColors');
      if (raw) this.laneColors.set(JSON.parse(raw));
    } catch {}
  }

  laneColor(laneId: string): string {
    return this.laneColors()[laneId] || '';
  }

  setLaneColor(laneId: string, color: string) {
    const m = { ...this.laneColors() };
    if (!color) delete m[laneId]; else m[laneId] = color;
    this.laneColors.set(m);
  }

  loadAll() {
    this.loading.set(true);
    this.customersApi.list().subscribe({
      next: cs => {
        const m: Record<string, Customer> = {};
        for (const c of cs) m[c.id] = c;
        this.customersMap.set(m);
        this.allCustomers.set(cs);
        this.lanesApi.list().subscribe({
          next: lanes => {
            this.lanes.set(lanes);
            if (!this.ncLaneId()) this.ncLaneId.set(lanes[0]?.id ?? null);
            this.itemsApi.list().subscribe({
              next: rows => {
                const map: Record<string, WorkItem[]> = {};
                for (const l of lanes) map[l.id] = [];
                for (const r of rows) {
                  if (!map[r.laneId]) map[r.laneId] = [];
                  map[r.laneId].push({ ...r, customerId: r.customerId ?? '' });
                }
                for (const id of Object.keys(map)) map[id].sort((a,b) => (a.sort ?? 0) - (b.sort ?? 0));
                this.items.set(map);
                this.loading.set(false);
              },
              error: () => { this.status.set('Load items error'); this.loading.set(false); }
            });
          },
          error: () => { this.status.set('Load lanes error'); this.loading.set(false); }
        });
      },
      error: () => { this.status.set('Load customers error'); this.loading.set(false); }
    });
  }

  useExisting(c: Customer) {
    this.selectedExistingId.set(c.id);
    this.ncName.set(c.name || '');
    this.ncPhone.set(c.phone || '');
    this.ncEmail.set(c.email || '');
  }

  clearExisting() {
    this.selectedExistingId.set(null);
  }

  isSelected(c: Customer): boolean {
    return this.selectedExistingId() === c.id;
  }

  private normalizePhone(v: string): string {
    const s = (v || '').replace(/\D+/g, '');
    return s.length > 7 ? s.slice(-7) : s;
  }

  private emailsClose(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private phonesClose(a?: string, b?: string): boolean {
    const na = this.normalizePhone(a || '');
    const nb = this.normalizePhone(b || '');
    return !!na && na === nb;
  }

  private recomputeDupMatches(): void {
    const all = this.allCustomers();
    if (!all || !all.length) {
      this.dupMatches.set([]);
      return;
    }
    this.dupChecking.set(true);
    const phone = this.ncPhone().trim();
    const email = this.ncEmail().trim();
    const byEmail = email.includes('@') ? all.filter(c => this.emailsClose(c.email, email)) : [];
    const byPhone = this.normalizePhone(phone).length >= 7 ? all.filter(c => this.phonesClose(c.phone, phone)) : [];
    const seen = new Set<string>();
    const merged: Customer[] = [];
    for (const c of [...byEmail, ...byPhone]) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        merged.push(c);
      }
    }
    this.dupMatches.set(merged.slice(0, 5));
    this.dupChecking.set(false);
  }

  private compareCreatedDesc(a: WorkItem, b: WorkItem): number {
    const ta = a.createdAt ? Date.parse(a.createdAt) : NaN;
    const tb = b.createdAt ? Date.parse(b.createdAt) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    if (Number.isFinite(tb)) return 1;
    if (Number.isFinite(ta)) return -1;
    const sa = (a as any).sort ?? 0;
    const sb = (b as any).sort ?? 0;
    return sb - sa;
  }

  createdAtLabel(it: WorkItem): string {
    if (!it.createdAt) return '';
    try { return new Date(it.createdAt).toLocaleString(); } catch { return String(it.createdAt); }
  }

  setLaneSort(laneId: string, mode: 'manual' | 'nameAsc' | 'nameDesc' | 'vehicleAsc' | 'vehicleDesc') {
    const m = { ...this.laneSorts() };
    m[laneId] = mode;
    this.laneSorts.set(m);
  }

  getLaneCards(laneId: string): WorkItem[] {
    const base = this.items()[laneId] || [];
    const arr = [...base];
    arr.sort((a, b) => this.compareCreatedDesc(a, b));
    return arr;
  }

  addLane() {
    const name = this.newLane().trim();
    if (!name) return;
    this.status.set('Saving lane');
    this.lanesApi.create(name).subscribe({
      next: () => { this.newLane.set(''); this.loadAll(); },
      error: () => this.status.set('Save lane error')
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
      map[targetId] = [...map[targetId]].sort((a, b) => this.compareCreatedDesc(a, b));
      this.items.set(map);
      return;
    } else {
      transferArrayItem(map[sourceId], map[targetId], event.previousIndex, event.currentIndex);
      this.items.set(map);
      const moved = map[targetId][event.currentIndex];
      this.itemsApi.update({ id: moved.id, laneId: targetLaneId }).subscribe({
        next: () => {
          map[targetId] = [...map[targetId]].sort((a, b) => this.compareCreatedDesc(a, b));
          map[sourceId] = [...map[sourceId]].sort((a, b) => this.compareCreatedDesc(a, b));
          this.items.set(map);
        }
      });
    }
  }

  customerName(it: WorkItem): string {
    const c = this.customersMap()[it.customerId ?? ''];
    const n = (c?.name || '').trim();
    if (n) return n;
    const t = (it.title || '').replace(/\[c=[^\]]+\]/gi, '').trim();
    const dashIdx = t.indexOf('—');
    const head = dashIdx >= 0 ? t.slice(0, dashIdx).trim() : t;
    const parenIdx = head.indexOf('(');
    const name = (parenIdx >= 0 ? head.slice(0, parenIdx) : head).trim();
    return name || 'No customer';
  }

  customerContact(it: WorkItem): string {
    const c = this.customersMap()[it.customerId ?? ''];
    return c?.phone || c?.email || '';
  }

  vehicleOf(it: WorkItem): string {
    const m = it.title.match(/\(([^)]+)\)/);
    return m?.[1] ?? '';
  }

  colorOf(it: WorkItem): string {
    const m = it.title.match(/\[c=([^\]]+)\]/);
    return m?.[1] ?? '';
  }

  notesOf(it: WorkItem): string {
    const title = it.title || '';
    const idx = title.indexOf('— ');
    if (idx < 0) return '';
    let note = title.slice(idx + 2);
    note = note.replace(/\[c=[^\]]+\]/gi, '').trim().replace(/\s{2,}/g, ' ');
    return note;
  }

  isExpanded(id: string): boolean {
    return !!this.expanded()[id];
  }

  toggleExpanded(id: string) {
    const e = { ...this.expanded() };
    e[id] = !e[id];
    this.expanded.set(e);
  }

  openNewModal() {
    this.editMode.set(false);
    this.editCustomerId.set(null);
    this.ncName.set('');
    this.ncPhone.set('');
    this.ncEmail.set('');
    this.ncVehicle.set('');
    this.ncNotes.set('');
    this.ncColor.set('');
    this.ncAlsoAdd.set(true);
    if (!this.ncLaneId()) this.ncLaneId.set(this.lanes()[0]?.id ?? null);
    this.selectedExistingId.set(null);
    this.dupMatches.set([]);
    this.dupChecking.set(false);
    this.openNew.set(true);
  }

  saveNewCustomer() {
    const name = this.ncName().trim();
    if (!name) { this.status.set('Name required'); return; }

    if (this.editMode()) {
      const id = this.editCustomerId();
      if (!id) { this.openNew.set(false); return; }
      const body = { id, name, phone: this.ncPhone().trim(), email: this.ncEmail().trim() };
      this.status.set('Saving customer');
      this.customersApi.upsert(body).subscribe({
        next: res => {
          const cm = { ...this.customersMap() };
          cm[id] = { id, name: body.name, phone: body.phone, email: body.email };
          this.customersMap.set(cm);
          const list = this.allCustomers().slice();
          const idx = list.findIndex(c => c.id === id);
          if (idx >= 0) list[idx] = cm[id]; else list.push(cm[id]);
          this.allCustomers.set(list);
          this.openNew.set(false);
          this.status.set('Saved');
        },
        error: () => this.status.set('Save customer error')
      });
      return;
    }

    const selected = this.selectedExistingId();
    if (selected) {
      const custId = selected;
      if (this.ncAlsoAdd() && this.ncLaneId()) {
        const parts: string[] = [name];
        if (this.ncVehicle().trim()) parts.push(`(${this.ncVehicle().trim()})`);
        if (this.ncNotes().trim()) parts.push(`— ${this.ncNotes().trim()}`);
        if (this.ncColor().trim()) parts.push(`[c=${this.ncColor().trim()}]`);
        const title = parts.join(' ');
        this.status.set('Creating card');
        this.itemsApi.create(title, this.ncLaneId()!).subscribe({
          next: created => {
            this.itemsApi.update({ id: created.id, customerId: custId }).subscribe({
              next: () => { this.openNew.set(false); this.loadAll(); this.status.set('Linked to existing'); }
            });
          },
          error: () => { this.status.set('Create card error'); }
        });
      } else {
        this.openNew.set(false);
        this.status.set('Linked to existing');
      }
      return;
    }

    const body = { name, phone: this.ncPhone().trim(), email: this.ncEmail().trim() };
    this.status.set('Saving customer');
    this.customersApi.upsert(body).subscribe({
      next: res => {
        const custId = res.id;
        if (this.ncAlsoAdd() && this.ncLaneId()) {
          const parts: string[] = [name];
          if (this.ncVehicle().trim()) parts.push(`(${this.ncVehicle().trim()})`);
          if (this.ncNotes().trim()) parts.push(`— ${this.ncNotes().trim()}`);
          if (this.ncColor().trim()) parts.push(`[c=${this.ncColor().trim()}]`);
          const title = parts.join(' ');
          this.itemsApi.create(title, this.ncLaneId()!).subscribe({
            next: created => {
              this.itemsApi.update({ id: created.id, customerId: custId }).subscribe({
                next: () => { this.openNew.set(false); this.loadAll(); this.status.set('Saved'); }
              });
            },
            error: () => { this.status.set('Create card error'); }
          });
        } else {
          this.openNew.set(false);
          this.loadAll();
          this.status.set('Saved');
        }
      },
      error: () => this.status.set('Save customer error')
    });
  }

  trackLane(_i: number, l: Lane) { return l.id; }
  trackItem(_i: number, it: WorkItem) { return it.id; }
}