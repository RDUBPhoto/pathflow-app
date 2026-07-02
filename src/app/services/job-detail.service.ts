import { Injectable, inject } from '@angular/core';
import { forkJoin, map, of } from 'rxjs';
import { AdditionalPart, AdditionalPartsApiService } from './additional-parts-api.service';
import { Attachment, AttachmentsApiService } from './attachments-api.service';
import { InventoryApiService, InventoryItem, InventoryNeed, JobPartStatus } from './inventory-api.service';
import { InvoiceDetail, InvoiceLineItem, InvoicesDataService } from './invoices-data.service';
import { PurchaseOrder, PurchaseOrderLine, PurchaseOrdersApiService } from './purchase-orders-api.service';
import { ScheduleApi, ScheduleItem } from './schedule-api.service';
import { Vendor, VendorsApiService } from './vendors-api.service';
import { WorkItem, WorkItemsApi } from './workitems-api.service';

export type JobDetailQuery = {
  jobId?: string;
  jobNumber?: string;
  needId?: string;
  scheduleId?: string;
  workItemId?: string;
  invoiceId?: string;
  invoiceLineItemId?: string;
};

export type JobDetailPart = {
  id: string;
  jobId: string;
  jobNumber: string;
  partName: string;
  sku: string;
  vendorId: string;
  vendor: string;
  status: JobPartStatus;
  qtyNeeded: number;
  qtyOrdered: number;
  qtyReceived: number;
  qtyPulled: number;
  qtyInstalled: number;
  relatedPoIds: string[];
  relatedScheduleId: string;
  relatedWorkItemId: string;
  relatedQuoteId: string;
  relatedInvoiceId: string;
  relatedInvoiceLineItemId: string;
  relatedInventoryItemId: string;
  note: string;
};

export type JobDetailPurchaseOrder = {
  order: PurchaseOrder;
  lines: PurchaseOrderLine[];
  vendor: string;
  receivedQty: number;
  totalQty: number;
};

export type JobDetailDocument = {
  document: InvoiceDetail;
  lines: InvoiceLineItem[];
};

export type JobDetailPayload = {
  query: JobDetailQuery;
  jobId: string;
  jobNumber: string;
  customerName: string;
  vehicle: string;
  installDate: string;
  status: string;
  partsReadiness: string;
  parts: JobDetailPart[];
  purchaseOrders: JobDetailPurchaseOrder[];
  quotes: JobDetailDocument[];
  invoices: JobDetailDocument[];
  additionalParts: AdditionalPart[];
  attachments: Attachment[];
  schedules: ScheduleItem[];
  workItems: WorkItem[];
  fallbackNotes: string[];
};

type MatchSets = {
  jobIds: Set<string>;
  jobNumbers: Set<string>;
  needIds: Set<string>;
  scheduleIds: Set<string>;
  workItemIds: Set<string>;
  invoiceIds: Set<string>;
  invoiceLineItemIds: Set<string>;
};

@Injectable({ providedIn: 'root' })
export class JobDetailService {
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly purchaseOrdersApi = inject(PurchaseOrdersApiService);
  private readonly scheduleApi = inject(ScheduleApi);
  private readonly workItemsApi = inject(WorkItemsApi);
  private readonly vendorsApi = inject(VendorsApiService);
  private readonly additionalPartsApi = inject(AdditionalPartsApiService);
  private readonly attachmentsApi = inject(AttachmentsApiService);

  load(query: JobDetailQuery) {
    return forkJoin({
      inventory: this.inventoryApi.getState(),
      purchaseOrders: this.purchaseOrdersApi.list(),
      schedules: this.scheduleApi.list(),
      workItems: this.workItemsApi.list(),
      vendors: this.vendorsApi.list('', true),
      additionalParts: this.additionalPartsApi.list({
        jobId: query.jobId,
        jobNumber: query.jobNumber,
        scheduleId: query.scheduleId,
        workItemId: query.workItemId,
        invoiceId: query.invoiceId
      }),
      attachments: this.attachmentsApi.list({
        jobId: query.jobId,
        jobNumber: query.jobNumber,
        scheduleId: query.scheduleId,
        workItemId: query.workItemId
      }),
      documents: of(this.invoicesData.invoiceDetails())
    }).pipe(
      map(({ inventory, purchaseOrders, schedules, workItems, vendors, additionalParts, attachments, documents }) => {
        const needs = Array.isArray(inventory?.needs) ? inventory.needs : [];
        const items = Array.isArray(inventory?.items) ? inventory.items : [];
        return this.assemble(query, {
          needs,
          items,
          purchaseOrders: Array.isArray(purchaseOrders?.items) ? purchaseOrders.items : [],
          schedules: Array.isArray(schedules) ? schedules : [],
          workItems: Array.isArray(workItems) ? workItems : [],
          vendors: Array.isArray(vendors?.vendors) ? vendors.vendors : [],
          additionalParts: Array.isArray(additionalParts?.parts) ? additionalParts.parts : [],
          attachments: Array.isArray(attachments?.attachments) ? attachments.attachments : [],
          documents: Array.isArray(documents) ? documents : []
        });
      })
    );
  }

  private assemble(
    query: JobDetailQuery,
    data: {
      needs: InventoryNeed[];
      items: InventoryItem[];
      purchaseOrders: PurchaseOrder[];
      schedules: ScheduleItem[];
      workItems: WorkItem[];
      vendors: Vendor[];
      additionalParts: AdditionalPart[];
      attachments: Attachment[];
      documents: InvoiceDetail[];
    }
  ): JobDetailPayload {
    const sets = this.seedSets(query);
    const fallbackNotes: string[] = [];
    let matchedNeeds = data.needs.filter(need => this.needMatches(need, sets));

    if (!matchedNeeds.length && sets.needIds.size) {
      matchedNeeds = data.needs.filter(need => sets.needIds.has(this.key(need.id)));
    }
    matchedNeeds.forEach(need => this.expandFromNeed(sets, need));

    const matchedDocuments = data.documents.filter(document => this.documentMatches(document, sets));
    matchedDocuments.forEach(document => this.expandFromDocument(sets, document));

    const matchedSchedules = data.schedules.filter(schedule => this.scheduleMatches(schedule, sets));
    matchedSchedules.forEach(schedule => sets.scheduleIds.add(this.key(schedule.id)));

    const matchedWorkItems = data.workItems.filter(item => this.workItemMatches(item, sets));
    matchedWorkItems.forEach(item => sets.workItemIds.add(this.key(item.id)));

    const matchedPurchaseOrders = data.purchaseOrders
      .map(order => ({
        order,
        lines: (order.lines || []).filter(line => this.poLineMatches(line, sets))
      }))
      .filter(row => row.lines.length);
    matchedPurchaseOrders.forEach(row => {
      for (const line of row.lines) this.expandFromPoLine(sets, line);
    });

    const vendorById = new Map(data.vendors.map(vendor => [this.key(vendor.id), vendor]));
    const itemById = new Map(data.items.map(item => [this.key(item.id), item]));
    const poIdsByNeed = this.poIdsByNeed(matchedPurchaseOrders);
    const parts = matchedNeeds.map(need => this.toPart(need, vendorById, itemById, poIdsByNeed));

    if (!parts.length && matchedDocuments.length) {
      fallbackNotes.push('No inventoryneeds/job-part rows matched yet; quote or invoice records are shown as connected context only.');
    }

    const quotes = this.toDocumentSummaries(matchedDocuments.filter(document => document.documentType === 'quote'), sets);
    const invoices = this.toDocumentSummaries(matchedDocuments.filter(document => document.documentType === 'invoice'), sets);
    const purchaseOrders = matchedPurchaseOrders.map(row => this.toPurchaseOrderSummary(row.order, row.lines, vendorById));

    const jobNumber = this.firstValue(
      ...matchedNeeds.map(need => need.jobNumber),
      ...matchedDocuments.map(document => document.jobNumber),
      this.anyValue(sets.jobNumbers),
      query.jobNumber
    );
    const jobId = this.firstValue(
      ...matchedNeeds.map(need => need.jobId),
      this.anyValue(sets.jobIds),
      query.jobId,
      jobNumber ? `job-number:${jobNumber}` : ''
    );
    const customerName = this.firstValue(
      ...matchedNeeds.map(need => need.customerName),
      ...matchedDocuments.map(document => document.customerName),
      ...matchedSchedules.map(schedule => schedule.title),
      ...matchedWorkItems.map(item => item.title),
      'Customer TBD'
    );
    const vehicle = this.firstValue(
      ...matchedNeeds.map(need => need.vehicle),
      ...matchedDocuments.map(document => document.vehicle),
      ...matchedWorkItems.map(item => this.workItemVehicle(item)),
      'Vehicle TBD'
    );
    const installDate = this.firstValue(
      ...matchedNeeds.map(need => need.scheduleStart),
      ...matchedSchedules.map(schedule => schedule.start)
    );

    return {
      query,
      jobId,
      jobNumber,
      customerName,
      vehicle,
      installDate,
      status: this.statusFor(matchedWorkItems, matchedSchedules),
      partsReadiness: this.partsReadiness(parts),
      parts,
      purchaseOrders,
      quotes,
      invoices,
      additionalParts: data.additionalParts,
      attachments: data.attachments,
      schedules: matchedSchedules,
      workItems: matchedWorkItems,
      fallbackNotes
    };
  }

  private seedSets(query: JobDetailQuery): MatchSets {
    const sets: MatchSets = {
      jobIds: new Set(),
      jobNumbers: new Set(),
      needIds: new Set(),
      scheduleIds: new Set(),
      workItemIds: new Set(),
      invoiceIds: new Set(),
      invoiceLineItemIds: new Set()
    };
    this.add(sets.jobIds, query.jobId);
    this.add(sets.jobNumbers, query.jobNumber);
    this.add(sets.needIds, query.needId);
    this.add(sets.scheduleIds, query.scheduleId);
    this.add(sets.workItemIds, query.workItemId);
    this.add(sets.invoiceIds, query.invoiceId);
    this.add(sets.invoiceLineItemIds, query.invoiceLineItemId);

    for (const jobId of Array.from(sets.jobIds)) {
      if (jobId.startsWith('job-number:')) this.add(sets.jobNumbers, jobId.slice('job-number:'.length));
      if (jobId.startsWith('schedule:')) this.add(sets.scheduleIds, jobId.slice('schedule:'.length));
      if (jobId.startsWith('work-item:')) this.add(sets.workItemIds, jobId.slice('work-item:'.length));
    }

    return sets;
  }

  private needMatches(need: InventoryNeed, sets: MatchSets): boolean {
    return this.has(sets.needIds, need.id)
      || this.has(sets.jobIds, need.jobId)
      || this.has(sets.jobNumbers, need.jobNumber)
      || this.has(sets.scheduleIds, need.relatedScheduleId)
      || this.has(sets.workItemIds, need.relatedWorkItemId)
      || this.has(sets.invoiceIds, need.relatedQuoteId)
      || this.has(sets.invoiceIds, need.relatedInvoiceId)
      || this.has(sets.invoiceLineItemIds, need.relatedInvoiceLineItemId);
  }

  private documentMatches(document: InvoiceDetail, sets: MatchSets): boolean {
    return this.has(sets.invoiceIds, document.id)
      || this.has(sets.invoiceIds, document.invoiceNumber)
      || this.has(sets.jobNumbers, document.jobNumber)
      || (document.lineItems || []).some(line => this.has(sets.invoiceLineItemIds, line.id) || this.has(sets.needIds, line.jobPartId));
  }

  private scheduleMatches(schedule: ScheduleItem, sets: MatchSets): boolean {
    return this.has(sets.scheduleIds, schedule.id) || this.has(sets.jobIds, `schedule:${schedule.id}`);
  }

  private workItemMatches(item: WorkItem, sets: MatchSets): boolean {
    return this.has(sets.workItemIds, item.id) || this.has(sets.jobIds, `work-item:${item.id}`);
  }

  private poLineMatches(line: PurchaseOrderLine, sets: MatchSets): boolean {
    return this.has(sets.needIds, line.needId)
      || this.has(sets.jobIds, line.jobId)
      || this.has(sets.jobNumbers, line.jobNumber);
  }

  private expandFromNeed(sets: MatchSets, need: InventoryNeed): void {
    this.add(sets.needIds, need.id);
    this.add(sets.jobIds, need.jobId);
    this.add(sets.jobNumbers, need.jobNumber);
    this.add(sets.scheduleIds, need.relatedScheduleId);
    this.add(sets.workItemIds, need.relatedWorkItemId);
    this.add(sets.invoiceIds, need.relatedQuoteId);
    this.add(sets.invoiceIds, need.relatedInvoiceId);
    this.add(sets.invoiceLineItemIds, need.relatedInvoiceLineItemId);
  }

  private expandFromDocument(sets: MatchSets, document: InvoiceDetail): void {
    this.add(sets.invoiceIds, document.id);
    this.add(sets.invoiceIds, document.invoiceNumber);
    this.add(sets.jobNumbers, document.jobNumber);
    for (const line of document.lineItems || []) {
      this.add(sets.invoiceLineItemIds, line.id);
      this.add(sets.needIds, line.jobPartId);
    }
  }

  private expandFromPoLine(sets: MatchSets, line: PurchaseOrderLine): void {
    this.add(sets.needIds, line.needId);
    this.add(sets.jobIds, line.jobId);
    this.add(sets.jobNumbers, line.jobNumber);
  }

  private toPart(
    need: InventoryNeed,
    vendorById: Map<string, Vendor>,
    itemById: Map<string, InventoryItem>,
    poIdsByNeed: Map<string, string[]>
  ): JobDetailPart {
    const inventoryItem = itemById.get(this.key(need.relatedInventoryItemId));
    const vendor = vendorById.get(this.key(need.vendorId));
    return {
      id: need.id,
      jobId: String(need.jobId || ''),
      jobNumber: String(need.jobNumber || ''),
      partName: String(need.partName || need.description || inventoryItem?.name || 'Part'),
      sku: String(need.sku || inventoryItem?.sku || ''),
      vendorId: String(need.vendorId || inventoryItem?.vendorId || ''),
      vendor: String(vendor?.name || need.vendorHint || inventoryItem?.vendor || ''),
      status: this.normalizeJobPartStatus(need.jobPartStatus || need.status),
      qtyNeeded: this.toNumber(need.qtyNeeded, this.toNumber(need.qty, 1)),
      qtyOrdered: this.toNumber(need.qtyOrdered, 0),
      qtyReceived: this.toNumber(need.qtyReceived, 0),
      qtyPulled: this.toNumber(need.qtyPulled, 0),
      qtyInstalled: this.toNumber(need.qtyInstalled, 0),
      relatedPoIds: poIdsByNeed.get(this.key(need.id)) || [],
      relatedScheduleId: String(need.relatedScheduleId || ''),
      relatedWorkItemId: String(need.relatedWorkItemId || ''),
      relatedQuoteId: String(need.relatedQuoteId || ''),
      relatedInvoiceId: String(need.relatedInvoiceId || ''),
      relatedInvoiceLineItemId: String(need.relatedInvoiceLineItemId || ''),
      relatedInventoryItemId: String(need.relatedInventoryItemId || ''),
      note: String(need.note || need.description || '')
    };
  }

  private poIdsByNeed(rows: Array<{ order: PurchaseOrder; lines: PurchaseOrderLine[] }>): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const row of rows) {
      for (const line of row.lines) {
        const needId = this.key(line.needId);
        if (!needId) continue;
        map.set(needId, [...(map.get(needId) || []), row.order.id]);
      }
    }
    return map;
  }

  private toPurchaseOrderSummary(
    order: PurchaseOrder,
    lines: PurchaseOrderLine[],
    vendorById: Map<string, Vendor>
  ): JobDetailPurchaseOrder {
    const vendor = vendorById.get(this.key(order.vendorId));
    return {
      order,
      lines,
      vendor: String(vendor?.name || order.supplier || lines.find(line => line.vendor)?.vendor || ''),
      receivedQty: lines.reduce((sum, line) => sum + this.toNumber(line.qtyReceived, 0), 0),
      totalQty: lines.reduce((sum, line) => sum + this.toNumber(line.qty, 0), 0)
    };
  }

  private toDocumentSummaries(documents: InvoiceDetail[], sets: MatchSets): JobDetailDocument[] {
    return documents.map(document => {
      const matchedLines = (document.lineItems || []).filter(line => {
        if (!sets.invoiceLineItemIds.size && !sets.needIds.size) return true;
        return this.has(sets.invoiceLineItemIds, line.id) || this.has(sets.needIds, line.jobPartId);
      });
      return {
        document,
        lines: matchedLines.length ? matchedLines : document.lineItems || []
      };
    });
  }

  private statusFor(workItems: WorkItem[], schedules: ScheduleItem[]): string {
    const completed = workItems.find(item => item.completedAt);
    if (completed) return 'Completed';
    const active = workItems.find(item => item.laneId);
    if (active) return active.laneId;
    if (schedules.length) return 'Scheduled';
    return 'Open';
  }

  private partsReadiness(parts: JobDetailPart[]): string {
    if (!parts.length) return 'No job parts';
    const missing = parts.filter(part => part.qtyReceived < part.qtyNeeded).length;
    if (!missing) return 'Ready';
    return `${missing} part${missing === 1 ? '' : 's'} not fully received`;
  }

  private workItemVehicle(item: WorkItem): string {
    return [item.vehicleYear, item.vehicleMake, item.vehicleModel, item.vehicleTrim]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
  }

  private normalizeJobPartStatus(value: unknown): JobPartStatus {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'ordered' || normalized === 'po-draft' || normalized === 'needs-order') return 'ordered';
    if (normalized === 'received' || normalized === 'in-stock') return 'received';
    if (normalized === 'pulled') return 'pulled';
    if (normalized === 'installed') return 'installed';
    if (normalized === 'returned' || normalized === 'cancelled' || normalized === 'canceled') return 'returned';
    if (normalized === 'backordered') return 'backordered';
    return 'quoted';
  }

  private firstValue(...values: Array<unknown>): string {
    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    return '';
  }

  private anyValue(values: Set<string>): string {
    return Array.from(values).find(Boolean) || '';
  }

  private add(set: Set<string>, value: unknown): void {
    const key = this.key(value);
    if (key) set.add(key);
  }

  private has(set: Set<string>, value: unknown): boolean {
    const key = this.key(value);
    return !!key && set.has(key);
  }

  private key(value: unknown): string {
    return String(value || '').trim();
  }

  private toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(String(value ?? '').replace(/[$,%\s]/g, '').replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
