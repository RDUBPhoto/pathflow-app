import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

type SasResponse = {
  uploadUrl: string;
  url: string;
  expiresOn: string;
};

@Injectable({ providedIn: 'root' })
export class BrandingApi {
  constructor(private http: HttpClient) {}

  getUploadSas(fileName: string, contentType: string) {
    return this.http.post<SasResponse>('/api/brandingSas', { fileName, contentType });
  }
}
