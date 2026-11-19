import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { InvoicesDataService } from './invoices-data.service';

type PortalLine = { description: string; quantity: number; total: number; subtotal?: number; unitPrice?: number };
export type PortalPayment = { kind: string; date: string; amount: number; reference?: string };
export type PortalActivity = { at: string; label: string; stepId?: string; paymentIndex?: number };
export type PortalVisitStep = {
  id: string; label: string; icon: string; description: string; at: string;
  state: 'complete' | 'current' | 'upcoming' | 'closed'; events: PortalActivity[];
};
export type PortalDocument = {
  id: string; number: string; total: number; lines: PortalLine[];
  subtotal?: number; tax?: number; note?: string; issuedAt?: string;
};
export type CustomerVisit = {
  businessName: string;
  businessContact?: { address: string; phone: string; email: string };
  customerName: string;
  vehicle: string;
  progress: string;
  status: 'active' | 'read-only';
  expiresAt: string;
  appointment: { start: string; end: string; timeZone: string } | null;
  activity: PortalActivity[];
  timeline: PortalVisitStep[];
  quote: (PortalDocument & { stage: string; canRespond: boolean }) | null;
  invoice: (PortalDocument & { balance: number; dueDate: string; canPay: boolean; returnCredit?: number }) | null;
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
