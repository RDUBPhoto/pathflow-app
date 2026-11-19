import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import DashboardComponent from './dashboard.component';
import { Lane } from '../../services/lanes-api.service';
import { WorkItem } from '../../services/workitems-api.service';

describe('dashboard loading resilience', () => {
  const lanes: Lane[] = [{ id: 'quotes', name: 'Quotes', stageKey: 'quote' }];
  const existing: WorkItem = { id: 'quote-1', laneId: 'quotes', title: 'Existing quote' };

  function board(itemsResult: WorkItem[] | Error) {
    const component = Object.create(DashboardComponent.prototype) as any;
    const originalItems = { quotes: [existing] };
    component.auth = { initialized: () => true, isAuthenticated: () => true };
    component.invoicesData = { documentSyncReady: () => true };
    component.loading = signal(false);
    component.status = signal('');
    component.boardLoadError = signal('');
    component.items = signal(originalItems);
    component.lanes = signal(lanes);
    component.customersMap = signal({});
    component.allCustomers = signal([]);
    component.scheduleItems = signal([]);
    component.shopTimeZone = signal('America/Chicago');
    component.hasLoadedBoard = true;
    component.loadAllGeneration = 0;
    component.loadAllRetryTimer = null;
    component.customersApi = { list: () => of([]) };
    component.scheduleApi = { list: () => of([]), getShopTimeZone: () => of('America/Chicago') };
    component.lanesApi = { list: () => of(lanes) };
    component.itemsApi = {
      list: () => itemsResult instanceof Error
        ? throwError(() => itemsResult)
        : of(itemsResult)
    };
    component.pruneDuplicateDocumentCards = jasmine.createSpy('pruneDuplicateDocumentCards').and.returnValue(false);
    component.ensureDocumentCardsExist = jasmine.createSpy('ensureDocumentCardsExist').and.returnValue(false);
    component.scheduleDashboardLoadRetry = jasmine.createSpy('scheduleDashboardLoadRetry');
    for (const method of [
      'maybeInitializeSeenLeads', 'maybeInitializeSeenCards', 'maybeInitializeNotifiedLeads',
      'maybeNotifyNewLeads', 'applyOpenedNotificationSeenHints', 'syncFinalPaidInvoicesToCompleted',
      'syncScheduledLane', 'syncInvoiceResponsesFromApi'
    ]) component[method] = () => {};
    return { component, originalItems };
  }

  it('treats a timed-out items fetch as an error, keeps the last good board, and retries without reconciliation', () => {
    const timeout = new Error('Timeout has occurred');
    timeout.name = 'TimeoutError';
    const { component, originalItems } = board(timeout);

    component.loadAll();

    expect(component.status()).toBe('Load items timed out');
    expect(component.statusToastColor(component.status())).toBe('danger');
    expect(component.boardLoadError()).toContain('last loaded board');
    expect(component.items()).toBe(originalItems);
    expect(component.pruneDuplicateDocumentCards).not.toHaveBeenCalled();
    expect(component.ensureDocumentCardsExist).not.toHaveBeenCalled();
    expect(component.scheduleDashboardLoadRetry).toHaveBeenCalledWith(1);
  });

  it('distinguishes a legitimate empty result from a failed request', () => {
    const { component } = board([]);

    component.loadAll();

    expect(component.status()).toBe('');
    expect(component.boardLoadError()).toBe('');
    expect(component.items()).toEqual({ quotes: [] });
    expect(component.pruneDuplicateDocumentCards).toHaveBeenCalledTimes(1);
  });

  it('waits for shared documents before reconciling an empty board against the browser cache', () => {
    const { component } = board([]);
    component.invoicesData.documentSyncReady = () => false;
    component.loadAll();
    expect(component.items()).toEqual({ quotes: [] });
    expect(component.pruneDuplicateDocumentCards).not.toHaveBeenCalled();
    expect(component.ensureDocumentCardsExist).not.toHaveBeenCalled();
  });

  it('reports a non-timeout request failure accurately', () => {
    const { component } = board(new Error('Network unavailable'));
    component.loadAll();
    expect(component.status()).toBe('Load items failed');
    expect(component.statusToastColor(component.status())).toBe('danger');
  });

  it('continues backing off after the initial retries instead of leaving the board stranded', () => {
    const { component } = board(new Error('Temporary failure'));
    component.loadAll(3);
    expect(component.scheduleDashboardLoadRetry).toHaveBeenCalledWith(4);
  });

  it('shows available cards but skips reconciliation when customer data is missing', () => {
    const current: WorkItem = { id: 'current', laneId: 'quotes', title: 'Current quote' };
    const { component } = board([current]);
    component.customersApi.list = () => throwError(() => new Error('Temporary failure'));

    component.loadAll();

    expect(component.items()['quotes'].map((item: WorkItem) => item.id)).toEqual(['current']);
    expect(component.boardLoadError()).toContain('Some dashboard data');
    expect(component.pruneDuplicateDocumentCards).not.toHaveBeenCalled();
    expect(component.ensureDocumentCardsExist).not.toHaveBeenCalled();
    expect(component.scheduleDashboardLoadRetry).toHaveBeenCalledWith(1);
  });

  it('ignores an older load that completes after a newer board load', () => {
    const { component } = board([]);
    const slowFirst = new Subject<WorkItem[]>();
    const current: WorkItem = { id: 'current', laneId: 'quotes', title: 'Current quote' };
    let calls = 0;
    component.itemsApi.list = () => ++calls === 1 ? slowFirst.asObservable() : of([current]);

    component.loadAll();
    component.loadAll();
    slowFirst.next([existing]);
    slowFirst.complete();

    expect(component.items()['quotes'].map((item: WorkItem) => item.id)).toEqual(['current']);
    expect(component.pruneDuplicateDocumentCards).toHaveBeenCalledTimes(1);
  });

  it('colors failure messages red and completed actions green', () => {
    const { component } = board([]);
    for (const message of ['Load items timeout', 'Load lanes timed out', 'Load customers failed', 'Lane not empty', 'No customer linked to this lead yet.', 'No appointment found for this card.', 'Select a customer before creating a quote.', 'Something went wrong']) {
      expect(component.statusToastColor(message)).withContext(message).toBe('danger');
    }
    for (const message of ['Saved', 'Appointment override saved', 'Moved to Scheduled', 'Added to Completed. Click "No appointment required" to confirm override.']) {
      expect(component.statusToastColor(message)).withContext(message).toBe('success');
    }
  });

  it('creates a danger-colored toast for the original timeout message', async () => {
    const { component } = board([]);
    const present = jasmine.createSpy('present').and.resolveTo();
    component.toastController = {
      create: jasmine.createSpy('create').and.resolveTo({ present })
    };

    await component.presentStatusToast('Load items timeout');

    expect(component.toastController.create).toHaveBeenCalledWith(jasmine.objectContaining({
      message: 'Load items timeout',
      color: 'danger'
    }));
    expect(present).toHaveBeenCalled();
  });
});
