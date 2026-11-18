import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { InvoicesDataService } from './invoices-data.service';

type PortalLine = { description: string; quantity: number; total: number };
export type PortalPayment = { kind: string; date: string; amount: number; reference?: string };
export type CustomerVisit = {
  businessName: string;
  customerName: string;
  vehicle: string;
  progress: string;
  status: 'active' | 'read-only';
  expiresAt: string;
  appointment: { start: string; end: string; timeZone: string } | null;
  activity: Array<{ at: string; label: string }>;
  quote: { id: string; number: string; stage: string; total: number; note: string; lines: PortalLine[]; canRespond: boolean } | null;
  invoice: { id: string; number: string; total: number; balance: number; dueDate: string; lines: PortalLine[]; canPay: boolean } | null;
  payments: PortalPayment[];
};

type PortalAccess = {
  status: 'active' | 'read-only' | 'expired' | 'revoked';
  expiresAt: string;
  path?: string;
};

@Injectable({ providedIn: 'root' })
export class CustomerPortalApi {
  private readonly http = inject(HttpClient);
  private readonly documents = inject(InvoicesDataService);

  read(tenantId: string, token: string) {
    return firstValueFrom(this.http.get<CustomerVisit>('/api/customer-portal', {
      headers: { 'x-tenant-id': tenantId, 'x-visit-token': token, 'x-skip-action-toast': '1' }
    }));
  }

  async manage(documentId: string, action: 'issue' | 'rotate' | 'revoke'): Promise<PortalAccess> {
    if (action !== 'revoke') await this.documents.waitForSharedDocument(documentId);
    return firstValueFrom(this.http.post<PortalAccess>('/api/customer-portal', { documentId, action }, {
      headers: { 'x-skip-action-toast': '1' }
    }));
  }

  async issueLink(documentId: string): Promise<string> {
    const access = await this.manage(documentId, 'issue');
    if (!access.path) throw new Error('Create a new customer portal link from the document before sharing this visit.');
    return access.path;
  }

  async appointmentUrl(workItemId: string | undefined): Promise<string> {
    if (!workItemId) return '';
    try {
      const access = await firstValueFrom(this.http.post<PortalAccess>('/api/customer-portal', {
        workItemId, action: 'issue'
      }, { headers: { 'x-skip-action-toast': '1' } }));
      return access.path ? new URL(access.path, window.location.origin).href : '';
    } catch {
      return '';
    }
  }
}
