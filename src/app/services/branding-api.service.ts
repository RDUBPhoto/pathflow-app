import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

type SasResponse = { uploadUrl: string; url: string; expiresOn: string };

@Injectable({ providedIn: 'root' })
export class BrandingApi {
  private base =
    typeof window !== 'undefined' && location.hostname === 'localhost'
      ? 'https://happy-desert-01944f00f.1.azurestaticapps.net'
      : '';

  constructor(private http: HttpClient) {}

  getUploadSas(fileName: string, contentType: string) {
    return this.http.post<SasResponse>(`${this.base}/api/brandingSas`, { fileName, contentType });
  }
}