import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, finalize } from 'rxjs';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSpinner,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import {
  Customer,
  CustomersApi,
  DuplicatePair,
  DuplicateReason
} from '../../services/customers-api.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';

type CustomerMap = Record<string, Customer>;

@Component({
  selector: 'app-customers-merge',
  standalone: true,
  imports: [
    CommonModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonButton,
    IonSpinner,
    IonBadge,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './customers-merge.component.html',
  styleUrls: ['./customers-merge.component.scss']
})
export default class CustomersMergeComponent implements OnInit, OnDestroy {
  private querySub: Subscription | null = null;

  readonly loading = signal(false);
  readonly merging = signal(false);
  readonly ignoring = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly selectedIndex = signal(0);
  readonly total = signal(0);
  readonly pairs = signal<DuplicatePair[]>([]);
  readonly customersById = signal<CustomerMap>({});

  readonly selectedPair = computed(() => {
    const all = this.pairs();
    const index = this.selectedIndex();
    return all[index] || null;
  });

  readonly leftCustomer = computed(() => {
    const pair = this.selectedPair();
    if (!pair) return null;
    return this.customersById()[pair.leftId] || null;
  });

  readonly rightCustomer = computed(() => {
    const pair = this.selectedPair();
    if (!pair) return null;
    return this.customersById()[pair.rightId] || null;
  });

  constructor(
    private readonly customersApi: CustomersApi,
    private readonly route: ActivatedRoute,
    private readonly router: Router
  ) {}

  openCustomerSms(customerId: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const id = String(customerId || '').trim();
    if (!id) return;
    this.router.navigate(['/customers', id], { queryParams: { tab: 'sms' } });
  }

  ngOnInit(): void {
    this.querySub = this.route.queryParamMap.subscribe(query => {
      const leftId = String(query.get('left') || query.get('current') || '').trim();
      const rightId = String(query.get('right') || query.get('other') || '').trim();
      this.refresh(leftId, rightId);
    });
  }

  ngOnDestroy(): void {
    this.querySub?.unsubscribe();
  }

  refresh(focusLeftId = '', focusRightId = ''): void {
    this.loading.set(true);
    this.error.set('');
    this.status.set('');

    this.customersApi.duplicateSummary(100, true)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: summary => {
          const pairs = Array.isArray(summary?.pairs) ? summary.pairs : [];
          const map: CustomerMap = {};
          const payloadMap = (summary?.customersById && typeof summary.customersById === 'object')
            ? summary.customersById
            : {};
          for (const [id, customer] of Object.entries(payloadMap)) {
            const cleanId = String(id || '').trim();
            if (!cleanId) continue;
            map[cleanId] = { ...(customer as Customer), id: cleanId };
          }

          const filteredPairs = pairs.filter(pair => !!map[pair.leftId] && !!map[pair.rightId]);
          const requested = this.tryBuildFocusPair(map, filteredPairs, focusLeftId, focusRightId);
          let nextPairs = filteredPairs;
          if (requested) {
            const key = this.pairKey(requested.leftId, requested.rightId);
            const existingIndex = filteredPairs.findIndex(pair => this.pairKey(pair.leftId, pair.rightId) === key);
            if (existingIndex !== -1) {
              this.selectedIndex.set(existingIndex);
            } else {
              this.selectedIndex.set(Math.min(this.selectedIndex(), Math.max(nextPairs.length - 1, 0)));
            }
          } else {
            this.selectedIndex.set(Math.min(this.selectedIndex(), Math.max(nextPairs.length - 1, 0)));
          }

          this.customersById.set(map);
          this.total.set(Number(summary?.total || nextPairs.length));
          this.pairs.set(nextPairs);
        },
        error: err => {
          const status = err?.status ? ` (${err.status})` : '';
          this.error.set(`Could not load duplicates${status}.`);
          this.pairs.set([]);
          this.total.set(0);
        }
      });
  }

  selectPair(index: number): void {
    if (index < 0 || index >= this.pairs().length) return;
    this.selectedIndex.set(index);
    this.status.set('');
    this.error.set('');
  }

  previousPair(): void {
    this.selectPair(this.selectedIndex() - 1);
  }

  nextPair(): void {
    this.selectPair(this.selectedIndex() + 1);
  }

  canGoPrevious(): boolean {
    return this.selectedIndex() > 0;
  }

  canGoNext(): boolean {
    return this.selectedIndex() < this.pairs().length - 1;
  }

  ignoreCurrentPair(): void {
    const pair = this.selectedPair();
    if (!pair) return;
    this.ignoring.set(true);
    this.error.set('');
    this.status.set('');
    this.customersApi.markNotDuplicate(pair.leftId, pair.rightId)
      .pipe(finalize(() => this.ignoring.set(false)))
      .subscribe({
        next: () => {
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: { left: null, right: null, current: null, other: null },
            queryParamsHandling: 'merge',
            replaceUrl: true
          });
          this.removeCurrentPair('Duplicate ignored.');
        },
        error: err => {
          const message = String(err?.error?.error || err?.message || 'Could not ignore duplicate.');
          this.error.set(message);
        }
      });
  }

  mergeInto(side: 'left' | 'right'): void {
    const pair = this.selectedPair();
    const left = this.leftCustomer();
    const right = this.rightCustomer();
    if (!pair || !left || !right) return;

    const targetId = side === 'left' ? pair.leftId : pair.rightId;
    const sourceId = side === 'left' ? pair.rightId : pair.leftId;
    this.merging.set(true);
    this.error.set('');
    this.status.set('');
    this.customersApi
      .mergeCustomers(targetId, sourceId)
      .pipe(finalize(() => this.merging.set(false)))
      .subscribe({
        next: () => {
          this.status.set('Customers merged successfully.');
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: { left: null, right: null, current: null, other: null },
            queryParamsHandling: 'merge',
            replaceUrl: true
          });
          this.refresh();
        },
        error: err => {
          const message = String(err?.error?.error || err?.message || 'Could not merge customers.');
          this.error.set(message);
        }
      });
  }

  openCustomer(customerId: string): void {
    const id = String(customerId || '').trim();
    if (!id) return;
    void this.router.navigate(['/customers', id]);
  }

  reasonLabel(reasons: DuplicateReason[] | string[]): string {
    const values = Array.from(
      new Set((Array.isArray(reasons) ? reasons : [])
        .map(reason => String(reason || '').toLowerCase().trim())
        .filter(Boolean))
    );
    if (!values.length) return 'Potential duplicate';

    return values
      .map(reason => {
        if (reason === 'vin') return 'VIN match';
        if (reason === 'email') return 'Email match';
        if (reason === 'phone') return 'Phone match';
        if (reason === 'name') return 'Name match';
        return reason;
      })
      .join(' + ');
  }

  customerName(customer: Customer | null): string {
    if (!customer) return 'Unknown customer';
    const first = String(customer.firstName || '').trim();
    const last = String(customer.lastName || '').trim();
    const full = `${first} ${last}`.trim();
    return full || String(customer.name || '').trim() || 'Unnamed customer';
  }

  customerVehicle(customer: Customer | null): string {
    if (!customer) return '';
    return [customer.vehicleYear, customer.vehicleMake, customer.vehicleModel]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
  }

  customerEmails(customer: Customer | null): string {
    if (!customer) return '';
    const emails = [customer.email, customer.secondaryEmail]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    return Array.from(new Set(emails)).join(' / ');
  }

  private removeCurrentPair(successMessage: string): void {
    const current = this.selectedIndex();
    const list = this.pairs().slice();
    if (current < 0 || current >= list.length) return;
    list.splice(current, 1);
    this.pairs.set(list);
    this.selectedIndex.set(Math.max(0, Math.min(current, list.length - 1)));
    this.total.set(Math.max(0, this.total() - 1));
    this.status.set(successMessage);
    this.error.set('');
  }

  private tryBuildFocusPair(map: CustomerMap, existing: DuplicatePair[], leftId: string, rightId: string): DuplicatePair | null {
    if (!leftId || !rightId || leftId === rightId) return null;
    const left = map[leftId];
    const right = map[rightId];
    if (!left || !right) return null;

    const existingKey = this.pairKey(leftId, rightId);
    const inList = existing.find(pair => this.pairKey(pair.leftId, pair.rightId) === existingKey);
    if (inList) return inList;

    const first = leftId < rightId ? left : right;
    const second = leftId < rightId ? right : left;
    const reasons: DuplicateReason[] = [];
    let score = 0;
    const firstVin = this.normalizeVin(first.vin);
    const secondVin = this.normalizeVin(second.vin);

    if (firstVin && firstVin === secondVin) {
      reasons.push('vin');
      score += 45;
    }

    if (this.normalizeEmail(first.email) && this.normalizeEmail(first.email) === this.normalizeEmail(second.email)) {
      reasons.push('email');
      score += 30;
    }
    if (this.normalizePhone(first.phone || first.mobile) &&
      this.normalizePhone(first.phone || first.mobile) === this.normalizePhone(second.phone || second.mobile)) {
      reasons.push('phone');
      score += 15;
    }
    if (this.normalizeName(this.customerName(first)) &&
      this.normalizeName(this.customerName(first)) === this.normalizeName(this.customerName(second))) {
      reasons.push('name');
      score += 10;
    }

    const confidence = Math.max(0, Math.min(100, Math.round(score)));
    const recommendation = confidence >= 80 ? 'auto-merge' : (confidence >= 55 ? 'review' : 'no-match');

    return {
      leftId: String(first.id),
      rightId: String(second.id),
      score: score || 10,
      confidence,
      recommendation,
      reasons: reasons.length ? reasons : ['name']
    };
  }

  private pairKey(a: string, b: string): string {
    const left = String(a || '').trim();
    const right = String(b || '').trim();
    return left < right ? `${left}::${right}` : `${right}::${left}`;
  }

  private normalizeEmail(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  private normalizePhone(value: unknown): string {
    const digits = String(value || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits.length > 10 ? digits.slice(-10) : digits;
  }

  private normalizeName(value: unknown): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private normalizeVin(value: unknown): string {
    return String(value || '').toUpperCase().replace(/\s+/g, '').trim();
  }
}
