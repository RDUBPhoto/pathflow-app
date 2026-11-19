import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { combineLatest, firstValueFrom } from 'rxjs';
import { CustomerPortalApi, CustomerVisit, PortalVisitStep } from '../../services/customer-portal-api.service';
import { QuoteResponseAction, QuoteResponseApiService } from '../../services/quote-response-api.service';
import { UiIcon } from '../../ui/icons';
import { downloadPortalDocument, portalDocument, PortalDocumentKind } from './portal-document';

@Component({
  standalone: true,
  imports: [CommonModule, RouterLink, UiIcon],
  templateUrl: './customer-portal.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './customer-portal.component.scss'
})
export default class CustomerPortalComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly portal = inject(CustomerPortalApi);
  private readonly quotes = inject(QuoteResponseApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly tenant = signal('');
  readonly token = signal('');
  readonly visit = signal<CustomerVisit | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly decisionError = signal('');
  readonly pendingDecision = signal<QuoteResponseAction | null>(null);
  readonly message = signal('');
  readonly timeline = computed(() => this.visit()?.timeline || []);
  readonly expandedStep = signal<string | null>(null);
  readonly downloadBusy = signal('');
  readonly downloadError = signal('');
  private loadGeneration = 0;

  constructor() {
    combineLatest([this.route.paramMap, this.route.fragment]).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(([params, token]) => {
      this.tenant.set(params.get('tenant') || '');
      this.token.set(token || '');
      this.visit.set(null);
      this.message.set('');
      this.decisionError.set('');
      this.pendingDecision.set(null);
      this.expandedStep.set(null);
      this.downloadError.set('');
      void this.load();
    });
  }

  async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loading.set(true);
    this.error.set('');
    try {
      const visit = await this.portal.read(this.tenant(), this.token());
      if (generation === this.loadGeneration) this.visit.set(visit);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.visit.set(null);
      this.error.set(this.errorMessage(error, 'Could not open your visit. Please try again.'));
    } finally {
      if (generation === this.loadGeneration) this.loading.set(false);
    }
  }

  async respond(action: QuoteResponseAction): Promise<void> {
    const quote = this.visit()?.quote;
    if (!quote?.canRespond || this.pendingDecision()) return;
    const tenant = this.tenant();
    const token = this.token();
    this.pendingDecision.set(action);
    this.decisionError.set('');
    try {
      const result = await firstValueFrom(this.quotes.capture({
        quoteId: quote.id, action, publicToken: token, tenantId: tenant
      }));
      if (token !== this.token() || tenant !== this.tenant()) return;
      if (!result.ok) throw new Error('The decision could not be saved.');
      this.visit.update(visit => visit ? {
        ...visit, quote: { ...quote, stage: result.stage, canRespond: false }
      } : null);
      this.message.set(result.stage === 'accepted' ? 'Quote accepted.' : 'Quote declined.');
      await this.load();
    } catch (error) {
      if (token === this.token() && tenant === this.tenant()) {
        this.decisionError.set(this.errorMessage(error, 'Could not save your decision. Refresh the visit and try again.'));
      }
    } finally {
      if (token === this.token() && tenant === this.tenant()) this.pendingDecision.set(null);
    }
  }

  appointmentDate(value: string, timeZone: string): string {
    const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : value + 'Z');
    if (Number.isNaN(date.getTime())) return value;
    const isInstant = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: isInstant ? timeZone : 'UTC', weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', ...(isInstant ? { timeZoneName: 'short' } : {})
    }).format(date);
  }

  isStepExpanded(step: PortalVisitStep): boolean {
    return this.expandedStep() === null ? step.state === 'current' || step.state === 'closed' : this.expandedStep() === step.id;
  }

  toggleStep(step: PortalVisitStep): void {
    this.expandedStep.set(this.isStepExpanded(step) ? '' : step.id);
  }

  stepStateLabel(step: PortalVisitStep): string {
    if (step.state === 'upcoming' && this.timeline().some(item => item.state === 'closed')) return 'Not started';
    return { complete: 'Complete', current: 'You are here', upcoming: 'Upcoming', closed: 'Closed' }[step.state];
  }

  async downloadPdf(kind: PortalDocumentKind, index?: number): Promise<void> {
    const visit = this.visit();
    if (!visit || this.downloadBusy()) return;
    const document = portalDocument(visit, kind, index);
    if (!document) return;
    this.downloadBusy.set(kind + (index ?? ''));
    this.downloadError.set('');
    try {
      await downloadPortalDocument(document);
    } catch {
      this.downloadError.set('Could not download this PDF. Please try again.');
    } finally {
      this.downloadBusy.set('');
    }
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof HttpErrorResponse ? String(error.error?.error || fallback) : fallback;
  }
}
