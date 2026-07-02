import { Injectable } from '@angular/core';
import { InvoiceDetail, InvoiceLineItem, InvoicePartStatus } from './invoices-data.service';
import { InventoryNeed, InventoryNeedStatus, JobPartStatus } from './inventory-api.service';
import { ScheduleItem } from './schedule-api.service';
import { WorkItem } from './workitems-api.service';

export type JobPartSourceType = 'quote' | 'invoice' | 'schedule' | 'manual' | 'inventory';

export type JobPartDraft = {
  id?: string;
  jobId: string;
  jobNumber?: string;
  relatedScheduleId?: string;
  relatedWorkItemId?: string;
  relatedQuoteId?: string;
  relatedInvoiceId?: string;
  relatedInvoiceLineItemId?: string;
  relatedInventoryItemId?: string;
  sourceType: JobPartSourceType;
  sourceId: string;
  partName: string;
  description?: string;
  sku?: string;
  status: JobPartStatus;
  legacyNeedStatus?: InventoryNeedStatus;
  qtyNeeded: number;
  qtyOrdered: number;
  qtyReceived: number;
  qtyPulled: number;
  qtyInstalled: number;
  cost: number;
  markup: number;
  customerPrice: number;
  note?: string;
};

@Injectable({ providedIn: 'root' })
export class JobPartsFoundationService {
  readonly statuses: JobPartStatus[] = [
    'quoted',
    'ordered',
    'received',
    'pulled',
    'installed',
    'returned',
    'backordered'
  ];

  jobIdForSchedule(schedule: Pick<ScheduleItem, 'id'>): string {
    return this.scheduleJobId(schedule.id);
  }

  jobIdForDocument(document: Pick<InvoiceDetail, 'jobNumber' | 'id'>): string {
    const jobNumber = this.safeText(document.jobNumber);
    return jobNumber ? `job-number:${jobNumber}` : `document:${this.safeText(document.id)}`;
  }

  mapInventoryNeedToJobPart(need: InventoryNeed): JobPartDraft {
    const qtyNeeded = this.safeQuantity(need.qtyNeeded ?? need.qty, 1);
    return {
      id: need.id,
      jobId: this.safeText(need.jobId) || this.fallbackJobIdForNeed(need),
      jobNumber: this.safeText(need.jobNumber),
      relatedScheduleId: this.safeText(need.relatedScheduleId),
      relatedWorkItemId: this.safeText(need.relatedWorkItemId),
      relatedQuoteId: this.safeText(need.relatedQuoteId),
      relatedInvoiceId: this.safeText(need.relatedInvoiceId),
      relatedInvoiceLineItemId: this.safeText(need.relatedInvoiceLineItemId),
      relatedInventoryItemId: this.safeText(need.relatedInventoryItemId),
      sourceType: this.normalizeSourceType(need.sourceType),
      sourceId: this.safeText(need.sourceId),
      partName: this.safeText(need.partName),
      description: this.safeText(need.description || need.note),
      sku: this.safeText(need.sku),
      status: this.mapNeedStatusToJobPartStatus(need.jobPartStatus || need.status),
      legacyNeedStatus: need.status,
      qtyNeeded,
      qtyOrdered: this.safeQuantity(need.qtyOrdered, 0),
      qtyReceived: this.safeQuantity(need.qtyReceived, 0),
      qtyPulled: this.safeQuantity(need.qtyPulled, 0),
      qtyInstalled: this.safeQuantity(need.qtyInstalled, 0),
      cost: this.safeMoney(need.cost),
      markup: this.safeMoney(need.markup),
      customerPrice: this.safeMoney(need.customerPrice),
      note: this.safeText(need.note)
    };
  }

  mapSchedulePartRequestToJobPartDraft(
    schedule: ScheduleItem,
    request: NonNullable<ScheduleItem['partRequests']>[number],
    workItem?: WorkItem | null
  ): JobPartDraft {
    const scheduleId = this.safeText(schedule.id);
    return {
      jobId: this.scheduleJobId(scheduleId),
      relatedScheduleId: scheduleId,
      relatedWorkItemId: this.safeText(workItem?.id),
      sourceType: 'schedule',
      sourceId: scheduleId,
      partName: this.safeText(request.partName),
      description: this.safeText(request.note),
      sku: this.safeText(request.sku),
      status: 'quoted',
      legacyNeedStatus: 'needs-order',
      qtyNeeded: this.safeQuantity(request.qty, 1),
      qtyOrdered: 0,
      qtyReceived: 0,
      qtyPulled: 0,
      qtyInstalled: 0,
      cost: 0,
      markup: 0,
      customerPrice: 0,
      note: this.safeText(request.note)
    };
  }

  mapInvoiceLineToJobPartDraft(document: InvoiceDetail, line: InvoiceLineItem): JobPartDraft | null {
    if (line.type !== 'part') return null;
    const documentId = this.safeText(document.id);
    const sourceType: JobPartSourceType = document.documentType === 'quote' ? 'quote' : 'invoice';
    const unitPrice = this.safeMoney(line.unitPrice);
    return {
      id: this.safeText(line.jobPartId),
      jobId: this.jobIdForDocument(document),
      jobNumber: this.safeText(document.jobNumber),
      relatedQuoteId: document.documentType === 'quote' ? documentId : '',
      relatedInvoiceId: document.documentType === 'invoice' ? documentId : '',
      relatedInvoiceLineItemId: this.safeText(line.id),
      relatedInventoryItemId: this.safeText(line.relatedInventoryItemId),
      sourceType,
      sourceId: documentId,
      partName: this.safeText(line.description) || this.safeText(line.code) || 'Part',
      description: this.safeText(line.description),
      sku: this.safeText(line.code),
      status: this.mapInvoicePartStatusToJobPartStatus(line.partStatus),
      legacyNeedStatus: this.mapInvoicePartStatusToNeedStatus(line.partStatus),
      qtyNeeded: this.safeQuantity(line.quantity, 1),
      qtyOrdered: 0,
      qtyReceived: this.mapInvoicePartStatusToJobPartStatus(line.partStatus) === 'received'
        ? this.safeQuantity(line.quantity, 1)
        : 0,
      qtyPulled: 0,
      qtyInstalled: 0,
      cost: 0,
      markup: 0,
      customerPrice: unitPrice,
      note: ''
    };
  }

  mapInvoicePartStatusToJobPartStatus(status: InvoicePartStatus | string | undefined): JobPartStatus {
    const value = this.safeText(status).toLowerCase();
    if (value === 'ordered') return 'ordered';
    if (value === 'received' || value === 'in-stock' || value === 'in stock') return 'received';
    if (value === 'backordered' || value === 'back-order' || value === 'back order') return 'backordered';
    return 'quoted';
  }

  mapInvoicePartStatusToNeedStatus(status: InvoicePartStatus | string | undefined): InventoryNeedStatus {
    const value = this.safeText(status).toLowerCase();
    if (value === 'ordered') return 'ordered';
    if (value === 'received' || value === 'in-stock' || value === 'in stock') return 'received';
    if (value === 'backordered' || value === 'back-order' || value === 'back order') return 'needs-order';
    return 'needs-order';
  }

  mapNeedStatusToJobPartStatus(status: JobPartStatus | InventoryNeedStatus | string | undefined): JobPartStatus {
    const value = this.safeText(status).toLowerCase();
    if (this.statuses.includes(value as JobPartStatus)) return value as JobPartStatus;
    if (value === 'po-draft') return 'ordered';
    if (value === 'cancelled' || value === 'canceled') return 'returned';
    if (value === 'needs-order') return 'quoted';
    return 'quoted';
  }

  private fallbackJobIdForNeed(need: InventoryNeed): string {
    if (this.safeText(need.relatedScheduleId)) return this.scheduleJobId(need.relatedScheduleId);
    if (this.safeText(need.jobNumber)) return `job-number:${this.safeText(need.jobNumber)}`;
    if (this.safeText(need.sourceType) && this.safeText(need.sourceId)) {
      return `${this.safeText(need.sourceType)}:${this.safeText(need.sourceId)}`;
    }
    return `inventory-need:${this.safeText(need.id)}`;
  }

  private normalizeSourceType(value: string): JobPartSourceType {
    const normalized = this.safeText(value).toLowerCase();
    if (normalized === 'quote' || normalized === 'invoice' || normalized === 'schedule' || normalized === 'inventory') {
      return normalized;
    }
    return 'manual';
  }

  private scheduleJobId(scheduleId: string | undefined): string {
    return `schedule:${this.safeText(scheduleId)}`;
  }

  private safeText(value: unknown): string {
    return value == null ? '' : String(value).trim();
  }

  private safeQuantity(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private safeMoney(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : 0;
  }
}
