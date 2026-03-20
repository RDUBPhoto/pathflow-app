import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from '../auth/auth.service';
import { NotificationsApiService } from './notifications-api.service';

describe('NotificationsApiService', () => {
  let service: NotificationsApiService;
  let httpMock: HttpTestingController;

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
    TestBed.configureTestingModule({
      providers: [
        NotificationsApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: authStub }
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
});
