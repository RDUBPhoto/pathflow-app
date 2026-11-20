import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from '../auth/auth.service';
import { NotificationsApiService } from './notifications-api.service';
import { TenantContextService } from './tenant-context.service';

describe('NotificationsApiService', () => {
  let service: NotificationsApiService;
  let httpMock: HttpTestingController;
  let tenantId: string;

  const authStub = {
    user: () => ({
      id: 'user-qa-1',
      email: 'qa@example.com',
      displayName: 'QA User',
      identityProvider: 'dev-local',
      roles: ['admin']
    })
  } as unknown as AuthService;

  beforeEach(() => {
    tenantId = 'shop-a';
    localStorage.removeItem('pathflow.notifications.opened.v2:shop-a:qa@example.com');
    localStorage.removeItem('pathflow.notifications.opened.v2:shop-b:qa@example.com');
    TestBed.configureTestingModule({
      providers: [
        NotificationsApiService,
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: authStub },
        { provide: TenantContextService, useValue: { tenantId: () => tenantId } }
      ]
    });

    service = TestBed.inject(NotificationsApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('requests recent notifications with actor query params', () => {
    service.listRecent(5).subscribe();

    const req = httpMock.expectOne(r =>
      r.url === '/api/notifications'
      && r.params.get('scope') === 'recent'
      && r.params.get('limit') === '5'
      && r.params.get('userId') === 'user-qa-1'
      && r.params.get('userEmail') === 'qa@example.com'
      && r.params.get('userName') === 'QA User'
    );

    expect(req.request.method).toBe('GET');
    req.flush({ ok: true, scope: 'recent', unreadCount: 0, total: 0, hasMore: false, items: [] });
  });

  it('creates mention notifications with actor metadata', () => {
    service.createMention({
      targetEmail: 'lead@example.com',
      title: 'Lead assigned',
      message: 'A lead has been assigned to you.',
      route: '/customers/123'
    }).subscribe();

    const req = httpMock.expectOne('/api/notifications');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.op).toBe('createMention');
    expect(req.request.body.actorUserId).toBe('user-qa-1');
    expect(req.request.body.actorEmail).toBe('qa@example.com');
    expect(req.request.body.actorDisplayName).toBe('QA User');

    req.flush({
      ok: true,
      scope: 'createMention',
      item: {
        id: 'n1',
        tenantId: 'main',
        type: 'mention',
        title: 'Lead assigned',
        message: 'A lead has been assigned to you.',
        route: '/customers/123',
        entityType: 'customer',
        entityId: '123',
        metadata: {},
        targetUserId: null,
        targetEmail: 'lead@example.com',
        targetDisplayName: null,
        actorUserId: 'user-qa-1',
        actorEmail: 'qa@example.com',
        actorDisplayName: 'QA User',
        read: false,
        readAt: null,
        createdAt: new Date().toISOString()
      }
    });
  });

  it('acknowledges exact documents, records the server read time and refreshes the bell', () => {
    const refresh = jasmine.createSpy('refresh');
    window.addEventListener('pathflow:notifications-refresh', refresh);
    try {
      service.acknowledgeView([{ type: 'invoice', id: 'invoice-1', number: 'INV-1' }]);
      const req = httpMock.expectOne('/api/notifications');
      expect(req.request.body).toEqual(jasmine.objectContaining({ op: 'markRelatedRead',
        contexts: [{ type: 'invoice', id: 'invoice-1', number: 'INV-1' }], actorUserId: 'user-qa-1' }));
      const readAt = new Date().toISOString();
      req.flush({ ok: true, updated: 2, readAt });
      expect(service.openedHints()).toEqual([jasmine.objectContaining({ entityId: 'invoice-1', openedAt: readAt })]);
      expect(refresh).toHaveBeenCalledTimes(1);
      tenantId = 'shop-b';
      expect(service.openedHints()).toEqual([]);
    } finally { window.removeEventListener('pathflow:notifications-refresh', refresh); }
  });

  it('does not acknowledge failed reads and allows a later retry', () => {
    const contexts = [{ type: 'invoice' as const, id: 'invoice-1' }];
    service.acknowledgeView(contexts);
    service.acknowledgeView(contexts);
    httpMock.expectOne('/api/notifications').flush({ error: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });
    expect(service.openedHints()).toEqual([]);
    service.acknowledgeView(contexts);
    httpMock.expectOne('/api/notifications').flush({ ok: true, updated: 1, readAt: new Date().toISOString() });
    expect(service.openedHints().length).toBe(1);
  });

  it('ignores another workspace and refreshes for read changes in a matching tab', () => {
    const refresh = jasmine.createSpy('refresh');
    window.addEventListener('pathflow:notifications-refresh', refresh);
    try {
      for (const scope of ['shop-b:qa@example.com', 'shop-a:other@example.com', 'shop-a:qa@example.com']) {
        window.dispatchEvent(new StorageEvent('storage', { key: 'pathflow.notifications.changed.v2', newValue: JSON.stringify({ scope }) }));
      }
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('pathflow:notifications-refresh', refresh); }
  });

  it('does not write read hints into a workspace selected while the request was pending', () => {
    service.acknowledgeView([{ type: 'invoice', id: 'invoice-1' }]);
    const req = httpMock.expectOne('/api/notifications');
    tenantId = 'shop-b';
    req.flush({ ok: true, updated: 1, readAt: new Date().toISOString() });
    expect(service.openedHints()).toEqual([]);
    tenantId = 'shop-a';
    expect(service.openedHints()).toEqual([]);
  });

  it('keeps records usable when browser storage is blocked', () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('Blocked');
    service.acknowledgeView([{ type: 'invoice', id: 'invoice-1' }]);
    expect(() => httpMock.expectOne('/api/notifications').flush({ ok: true, updated: 1, readAt: new Date().toISOString() })).not.toThrow();
  });
});
