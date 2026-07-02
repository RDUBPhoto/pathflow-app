import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type AttachmentCategory = 'receipt' | 'vendor_invoice' | 'photo' | 'document' | 'other';

export type Attachment = {
  id: string;
  jobId?: string;
  jobNumber?: string;
  relatedScheduleId?: string;
  relatedWorkItemId?: string;
  relatedInventoryNeedId?: string;
  jobPartId?: string;
  relatedAdditionalPartId?: string;
  relatedPurchaseOrderId?: string;
  relatedPurchaseOrderLineId?: string;
  relatedVendorId?: string;
  fileName: string;
  originalFileName: string;
  contentType: string;
  size: number;
  blobPath?: string;
  url: string;
  category: AttachmentCategory;
  description?: string;
  uploadedBy?: string;
  uploadedById?: string;
  uploadedAt?: string;
  isArchived?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type AttachmentQuery = {
  jobId?: string;
  jobNumber?: string;
  scheduleId?: string;
  workItemId?: string;
  inventoryNeedId?: string;
  jobPartId?: string;
  additionalPartId?: string;
  purchaseOrderId?: string;
  vendorId?: string;
  includeArchived?: boolean;
};

export type AttachmentUploadPayload = Partial<AttachmentQuery> & {
  relatedScheduleId?: string;
  relatedWorkItemId?: string;
  relatedInventoryNeedId?: string;
  relatedAdditionalPartId?: string;
  relatedPurchaseOrderId?: string;
  relatedPurchaseOrderLineId?: string;
  relatedVendorId?: string;
  fileName: string;
  originalFileName?: string;
  contentType: string;
  fileDataUrl: string;
  category: AttachmentCategory;
  description?: string;
};

@Injectable({ providedIn: 'root' })
export class AttachmentsApiService {
  constructor(private readonly http: HttpClient) {}

  list(query: AttachmentQuery = {}): Observable<{ ok: boolean; attachments: Attachment[] }> {
    const params = new URLSearchParams();
    if (query.jobId) params.set('jobId', query.jobId);
    if (query.jobNumber) params.set('jobNumber', query.jobNumber);
    if (query.scheduleId) params.set('scheduleId', query.scheduleId);
    if (query.workItemId) params.set('workItemId', query.workItemId);
    if (query.inventoryNeedId) params.set('inventoryNeedId', query.inventoryNeedId);
    if (query.jobPartId) params.set('jobPartId', query.jobPartId);
    if (query.additionalPartId) params.set('additionalPartId', query.additionalPartId);
    if (query.purchaseOrderId) params.set('purchaseOrderId', query.purchaseOrderId);
    if (query.vendorId) params.set('vendorId', query.vendorId);
    if (query.includeArchived) params.set('includeArchived', 'true');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.http.get<{ ok: boolean; attachments: Attachment[] }>(`/api/attachments${suffix}`);
  }

  upload(payload: AttachmentUploadPayload): Observable<{ ok: boolean; attachment: Attachment }> {
    return this.http.post<{ ok: boolean; attachment: Attachment }>('/api/attachments', {
      op: 'upload',
      ...payload
    });
  }

  archive(id: string): Observable<{ ok: boolean; attachment: Attachment }> {
    return this.http.post<{ ok: boolean; attachment: Attachment }>('/api/attachments', {
      op: 'archive',
      id
    });
  }

  fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
      reader.readAsDataURL(file);
    });
  }
}
