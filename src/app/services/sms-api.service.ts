import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type SmsMode = 'mock' | 'azure';
export type SmsDirection = 'inbound' | 'outbound';
export type SmsDeliveryStatus = 'queued' | 'delivered' | 'failed' | 'received' | 'unknown';

export type SmsSenderConfig = {
  fromNumber: string | null;
  label: string | null;
  verificationStatus: string | null;
  enabled: boolean;
  source: 'tenant' | 'env' | 'none';
};

export type SmsMessage = {
  id: string;
  customerId: string | null;
  customerName: string | null;
  direction: SmsDirection;
  from: string | null;
  to: string | null;
  message: string;
  createdAt: string;
  read: boolean;
  readAt: string | null;
  simulated: boolean;
  provider: string | null;
  providerMessageId: string | null;
  deliveryStatus: SmsDeliveryStatus;
  deliveryStatusRaw: string | null;
  deliveryUpdatedAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  providerErrorCode: string | null;
  providerErrorMessage: string | null;
};

export type SmsConfigResponse = {
  ok: boolean;
  tenantId: string;
  mode: SmsMode;
  provider: string;
  configured: {
    connectionString: boolean;
    fromNumber: boolean;
  };
  fromNumber: string | null;
  readyForLive: boolean;
  sender: SmsSenderConfig;
};

export type SmsSendResponse = {
  ok: boolean;
  tenantId: string;
  mode: SmsMode;
  provider: string;
  simulated: boolean;
  to: string;
  customerId: string | null;
  messageId: string | null;
  id: string;
  createdAt: string;
  deliveryStatus: SmsDeliveryStatus;
};

export type SmsInboxResponse = {
  ok: boolean;
  scope: 'inbox';
  items: SmsMessage[];
};

export type SmsCustomerResponse = {
  ok: boolean;
  scope: 'customer';
  customerId: string;
  items: SmsMessage[];
};

export type SmsThreadSummary = {
  key: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  latestMessage: string;
  latestAt: string;
  latestDirection: SmsDirection;
  unread: number;
  latestDeliveryStatus: SmsDeliveryStatus;
  latestDeliveryError: string | null;
};

export type SmsThreadsResponse = {
  ok: boolean;
  scope: 'threads';
  items: SmsThreadSummary[];
};

export type SmsSenderConfigResponse = {
  ok: boolean;
  tenantId: string;
  sender: SmsSenderConfig;
};

@Injectable({ providedIn: 'root' })
export class SmsApiService {
  constructor(private readonly http: HttpClient) {}

  getConfig(): Observable<SmsConfigResponse> {
    return this.http.get<SmsConfigResponse>('/api/sms');
  }

  getSenderConfig(): Observable<SmsSenderConfigResponse> {
    return this.http.get<SmsSenderConfigResponse>('/api/sms?scope=sender');
  }

  setSenderConfig(payload: {
    fromNumber: string;
    label?: string;
    verificationStatus?: string;
  }): Observable<SmsSenderConfigResponse> {
    return this.http.post<SmsSenderConfigResponse>('/api/sms', {
      op: 'setSenderConfig',
      ...payload
    });
  }

  clearSenderConfig(): Observable<SmsSenderConfigResponse> {
    return this.http.post<SmsSenderConfigResponse>('/api/sms', {
      op: 'clearSenderConfig'
    });
  }

  sendTest(to: string, message: string): Observable<SmsSendResponse> {
    return this.http.post<SmsSendResponse>('/api/sms', { to, message });
  }

  sendToCustomer(payload: {
    customerId: string;
    customerName?: string;
    to: string;
    message: string;
  }): Observable<SmsSendResponse> {
    return this.http.post<SmsSendResponse>('/api/sms', payload);
  }

  listInbox(): Observable<SmsInboxResponse> {
    return this.http.get<SmsInboxResponse>('/api/sms?scope=inbox');
  }

  listCustomerMessages(customerId: string): Observable<SmsCustomerResponse> {
    return this.http.get<SmsCustomerResponse>(`/api/sms?scope=customer&customerId=${encodeURIComponent(customerId)}`);
  }

  listThreads(limit?: number): Observable<SmsThreadsResponse> {
    const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : 0;
    const suffix = normalizedLimit > 0
      ? `&limit=${normalizedLimit}`
      : '';
    return this.http.get<SmsThreadsResponse>(`/api/sms?scope=threads${suffix}`);
  }

  markRead(id: string): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/sms', { op: 'markRead', id });
  }

  markReadBatch(ids: string[]): Observable<{ ok: boolean; updated: number }> {
    return this.http.post<{ ok: boolean; updated: number }>('/api/sms', { op: 'markReadBatch', ids });
  }

  logIncoming(payload: {
    customerId: string;
    customerName?: string;
    from?: string;
    message: string;
  }): Observable<{ ok: boolean; id: string; createdAt: string }> {
    return this.http.post<{ ok: boolean; id: string; createdAt: string }>('/api/sms', {
      op: 'logIncoming',
      ...payload
    });
  }
}
