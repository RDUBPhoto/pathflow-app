import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import { environment } from '../../../environments/environment';
import { formatUsPhoneInput } from '../../utils/phone-format';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonSpinner,
  IonText,
  IonTextarea,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';

type WidgetLeadResponse = {
  ok: boolean;
  customerId: string | null;
  customerName: string | null;
  customerCreated: boolean;
  leadId: string;
  leadCreated: boolean;
  duplicateLeadSkipped: boolean;
  sms?: {
    optInProvided: boolean;
    optInChecked: boolean;
    consentStatus: string;
    confirmationAttempted: boolean;
    confirmationSent: boolean;
    confirmationSimulated: boolean;
    confirmationStatus: string;
    confirmationMessageId: string | null;
    confirmationError: string | null;
  };
};

@Component({
  selector: 'app-sms-opt-in',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonItem,
    IonLabel,
    IonInput,
    IonTextarea,
    IonCheckbox,
    IonButton,
    IonText,
    IonBadge,
    IonSpinner
  ],
  templateUrl: './sms-opt-in.component.html',
  styleUrls: ['./sms-opt-in.component.scss']
})
export default class SmsOptInComponent {
  name = '';
  email = '';
  phone = '';
  vin = '';
  message = '';
  smsOptIn = false;

  readonly submitting = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly result = signal<WidgetLeadResponse | null>(null);
  readonly pageUrl = signal('');

  readonly privacyPolicyUrl = this.publicPageUrl('/privacy-policy');
  readonly smsTermsUrl = this.publicPageUrl('/terms-and-conditions');
  readonly otherOptInUrl = this.publicPageUrl('/sms-opt-in-other');
  readonly consentVersion = 'v1';
  readonly sourceName = 'pathflow-sms-opt-in-page';

  readonly consentText = `By checking this box, you agree to receive recurring SMS from Pathflow for appointment updates, job status, service notifications, billing alerts, and support. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help.`;

  readonly canSubmit = computed(() => {
    const hasContact = !!this.email.trim() || !!this.phone.trim();
    const hasName = !!this.name.trim();
    const hasVin = this.isValidVin(this.vin);
    const hasSmsConsent = !this.phone.trim() || this.smsOptIn;
    return hasName && hasContact && hasVin && hasSmsConsent && !this.submitting();
  });

  constructor(private readonly http: HttpClient) {
    if (typeof window !== 'undefined') {
      this.pageUrl.set(window.location.origin + '/sms-opt-in');
    }
  }

  submit(): void {
    this.status.set('');
    this.error.set('');
    this.result.set(null);

    const payload = {
      source: this.sourceName,
      name: this.name.trim(),
      email: this.email.trim(),
      phone: this.phone.trim(),
      vin: this.vin.trim().toUpperCase().replace(/\s+/g, ''),
      message: this.message.trim(),
      smsOptIn: this.smsOptIn,
      consentMethod: 'web-checkbox',
      smsConsentVersion: this.consentVersion,
      smsConsentText: this.consentText,
      optInPageUrl: this.pageUrl()
    };

    if (!payload.name) {
      this.error.set('Name is required.');
      return;
    }
    if (!payload.email && !payload.phone) {
      this.error.set('At least email or phone is required.');
      return;
    }
    if (!payload.vin) {
      this.error.set('VIN is required.');
      return;
    }
    if (!this.isValidVin(payload.vin)) {
      this.error.set('VIN must be 17 characters and cannot include I, O, or Q.');
      return;
    }
    if (payload.phone && !this.smsOptIn) {
      this.error.set('SMS opt-in checkbox is required when phone is provided.');
      return;
    }

    this.submitting.set(true);
    this.http.post<WidgetLeadResponse>('/api/widget/lead', payload)
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: response => {
          this.result.set(response);
          const smsState = response.sms?.confirmationSent
            ? 'SMS confirmation sent.'
            : (response.sms?.confirmationAttempted ? 'SMS confirmation attempted.' : 'No SMS confirmation sent.');
          this.status.set(`Lead captured successfully. ${smsState}`);
        },
        error: err => {
          this.error.set(this.extractError(err, 'Could not submit opt-in form.'));
        }
      });
  }

  onPhoneInput(value: string | null | undefined): void {
    this.phone = formatUsPhoneInput(value);
  }

  private extractError(err: unknown, fallback: string): string {
    if (err instanceof HttpErrorResponse) {
      const detail = typeof err.error === 'object' && err.error !== null
        ? (err.error.detail || err.error.error || err.message)
        : err.message;
      return `${fallback} ${String(detail)}`.trim();
    }
    return fallback;
  }

  private isValidVin(value: string): boolean {
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(String(value || '').trim().toUpperCase());
  }

  private publicPageUrl(path: string): string {
    const normalizedPath = `/${String(path || '').trim().replace(/^\/+/, '')}`;
    const configured = String(environment.publicAppUrl || '').trim().replace(/\/+$/, '');
    if (configured) return `${configured}${normalizedPath}`;
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin.replace(/\/+$/, '')}${normalizedPath}`;
    }
    return normalizedPath;
  }
}
