import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type EmailMode = 'mock' | 'sendgrid';
export type EmailDirection = 'inbound' | 'outbound';

export type EmailMessage = {
  id: string;
  customerId: string | null;
  customerName: string | null;
  direction: EmailDirection;
  from: string | null;
  to: string | null;
  subject: string;
  message: string;
  html: string | null;
  createdAt: string;
  read: boolean;
  readAt: string | null;
  simulated: boolean;
  provider: string | null;
  providerMessageId: string | null;
};

export type EmailConfigResponse = {
  ok: boolean;
  mode: EmailMode;
  provider: string;
  configured: {
    apiKey: boolean;
    fromEmail: boolean;
  };
  fromEmail: string | null;
  readyForLive: boolean;
};

export type EmailSendResponse = {
  ok: boolean;
  mode: EmailMode;
  provider: string;
  simulated: boolean;
  id: string;
  createdAt: string;
  to: string;
  customerId: string | null;
  messageId: string | null;
};

export type EmailInboxResponse = {
  ok: boolean;
  scope: 'inbox';
  items: EmailMessage[];
};

export type EmailCustomerResponse = {
  ok: boolean;
  scope: 'customer';
  customerId: string;
  items: EmailMessage[];
};

export type EmailThreadSummary = {
  key: string;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  latestSubject: string;
  latestMessage: string;
  latestAt: string;
  latestDirection: EmailDirection;
  unread: number;
};

export type EmailThreadsResponse = {
  ok: boolean;
  scope: 'threads';
  items: EmailThreadSummary[];
};

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  updatedAt: string;
};

export type EmailTemplatesResponse = {
  ok: boolean;
  scope?: 'templates';
  templates: EmailTemplate[];
  signature: string;
  id?: string;
};

export type EmailInboundLogResponse = {
  ok: boolean;
  direction: 'inbound';
  id: string;
  createdAt: string;
  customerId: string | null;
  customerName: string | null;
  customerCreated: boolean;
  leadCreated: boolean;
};

@Injectable({ providedIn: 'root' })
export class EmailApiService {
  constructor(private readonly http: HttpClient) {}

  getConfig(): Observable<EmailConfigResponse> {
    return this.http.get<EmailConfigResponse>('/api/email');
  }

  listInbox(): Observable<EmailInboxResponse> {
    return this.http.get<EmailInboxResponse>('/api/email?scope=inbox');
  }

  listCustomerMessages(customerId: string): Observable<EmailCustomerResponse> {
    return this.http.get<EmailCustomerResponse>(`/api/email?scope=customer&customerId=${encodeURIComponent(customerId)}`);
  }

  listThreads(limit?: number): Observable<EmailThreadsResponse> {
    const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : 0;
    const suffix = normalizedLimit > 0 ? `&limit=${normalizedLimit}` : '';
    return this.http.get<EmailThreadsResponse>(`/api/email?scope=threads${suffix}`);
  }

  sendToCustomer(payload: {
    customerId: string;
    customerName?: string;
    to: string;
    subject: string;
    message: string;
    html?: string;
  }): Observable<EmailSendResponse> {
    return this.http.post<EmailSendResponse>('/api/email', payload);
  }

  logIncoming(payload: {
    customerId?: string;
    customerName?: string;
    from: string;
    fromName?: string;
    subject: string;
    message: string;
    html?: string;
  }): Observable<EmailInboundLogResponse> {
    return this.http.post<EmailInboundLogResponse>('/api/email', {
      op: 'logIncoming',
      ...payload
    });
  }

  markRead(id: string): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/email', { op: 'markRead', id });
  }

  markReadBatch(ids: string[]): Observable<{ ok: boolean; updated: number }> {
    return this.http.post<{ ok: boolean; updated: number }>('/api/email', { op: 'markReadBatch', ids });
  }

  listTemplates(): Observable<EmailTemplatesResponse> {
    return this.http.get<EmailTemplatesResponse>('/api/email?scope=templates');
  }

  upsertTemplate(payload: {
    id?: string;
    name: string;
    subject: string;
    body: string;
  }): Observable<EmailTemplatesResponse> {
    return this.http.post<EmailTemplatesResponse>('/api/email', { op: 'upsertTemplate', ...payload });
  }

  deleteTemplate(id: string): Observable<EmailTemplatesResponse> {
    return this.http.post<EmailTemplatesResponse>('/api/email', { op: 'deleteTemplate', id });
  }

  setSignature(signature: string): Observable<EmailTemplatesResponse> {
    return this.http.post<EmailTemplatesResponse>('/api/email', { op: 'setSignature', signature });
  }
}
