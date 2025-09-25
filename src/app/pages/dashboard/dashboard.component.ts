import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonSpinner } from '@ionic/angular/standalone';
import { CdkDropList, CdkDrag, CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { HttpClient } from '@angular/common/http';
import { BrandingApi } from '../../services/branding-api.service';

type Card = { id: string; name: string };

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonSpinner,
    CdkDropList, CdkDrag
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export default class DashboardComponent {
  constructor(private http: HttpClient, private branding: BrandingApi) {}

  lead = signal<Card[]>([{ id: '1', name: 'John – Raptor shocks' }, { id: '2', name: 'Emily – Jeep lift' }]);
  quote = signal<Card[]>([{ id: '3', name: 'Carlos – Wheel/Tire' }]);
  invoiced = signal<Card[]>([]);

  pingResult = signal<string>('');
  logoUrl = signal<string>('');
  uploading = signal<boolean>(false);
  uploadMsg = signal<string>('');

  testPing() {
    this.pingResult.set('Testing…');
    this.http.get<{ ok: boolean; message: string }>('/api/ping').subscribe({
      next: res => this.pingResult.set(`ok=${res.ok}, message=${res.message}`),
      error: err => this.pingResult.set(`Error: ${err?.status || ''} ${err?.statusText || ''}`.trim())
    });
  }

  async uploadLogo(file: File | null) {
    if (!file) return;
    this.uploading.set(true);
    this.uploadMsg.set('Requesting upload URL…');

    try {
      const sas = await this.branding.getUploadSas(file.name, file.type || 'application/octet-stream').toPromise();
      if (!sas?.uploadUrl) throw new Error('No SAS upload URL returned');

      this.uploadMsg.set('Uploading…');

      const putRes = await fetch(sas.uploadUrl, {
        method: 'PUT',
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'Content-Type': file.type || 'application/octet-stream'
        },
        body: file
      });

      if (!putRes.ok) {
        const text = await putRes.text();
        throw new Error(`Blob upload failed: ${putRes.status} ${putRes.statusText} ${text}`);
      }

      this.logoUrl.set(sas.url);
      this.uploadMsg.set('Uploaded ✔');
    } catch (e: any) {
      this.uploadMsg.set(`Upload error: ${e?.message || e}`);
    } finally {
      this.uploading.set(false);
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.item(0) ?? null;
    this.uploadLogo(file);
  }

  dropped(event: CdkDragDrop<Card[]>) {
    if (event.previousContainer === event.container) {
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
    } else {
      transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex);
    }
  }
}
