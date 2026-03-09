import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

type SasResponse = { uploadUrl: string; url: string; expiresOn: string; tenantId: string };
type UploadResponse = { ok: boolean; url: string; tenantId: string; contentType: string; size: number };
type DeleteResponse = { ok: boolean; deleted: boolean; tenantId: string };

@Injectable({ providedIn: 'root' })
export class BrandingApi {
  constructor(private http: HttpClient) {}

  getUploadSas(fileName: string, contentType: string) {
    return this.http.post<SasResponse>('/api/brandingSas', { fileName, contentType });
  }

  uploadLogo(fileName: string, contentType: string, fileDataUrl: string) {
    return this.http.post<UploadResponse>('/api/brandingUpload', { fileName, contentType, fileDataUrl });
  }

  deleteLogo(logoUrl: string) {
    return this.http.request<DeleteResponse>('DELETE', '/api/brandingUpload', {
      body: { logoUrl }
    });
  }
}
