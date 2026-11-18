import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../auth/auth.service';
import { UiIcon } from '../../ui/icons';

@Component({
  selector: 'app-corp-home',
  standalone: true,
  imports: [RouterLink, UiIcon],
  templateUrl: './corp-home.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './corp-home.component.scss'
})
export default class CorpHomeComponent {
  readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly workflow = [
    { icon: 'message-dots', title: 'Capture the request', description: 'Log calls and collect requests from your website lead form.' },
    { icon: 'file-text', title: 'Get approval', description: 'Send a quote for review and turn approved work into an invoice.' },
    { icon: 'calendar-event', title: 'Book the work', description: 'Assign a bay, confirm the appointment, and check in the vehicle.' },
    { icon: 'circle-check', title: 'Close the visit', description: 'Mark work complete, collect any remaining balance, and record pickup.' }
  ];

  readonly features = [
    { icon: 'layout-grid', title: 'Workflow dashboard', description: 'See each visit in its current stage, from a new lead to completed work.' },
    { icon: 'credit-card', title: 'Quotes and payments', description: 'Price parts and labor, send invoices, and collect online payments through your connected provider.' },
    { icon: 'calendar', title: 'Calendar and job time', description: 'Schedule jobs by bay and track work time against your shop’s business hours.' },
    { icon: 'package', title: 'Inventory and purchasing', description: 'Track stock, vendors, purchase orders, and which parts are ready for each job.' },
    { icon: 'car', title: 'Customer and vehicle records', description: 'Keep vehicle details, service history, and the documents for each visit together.' },
    { icon: 'send', title: 'Email and SMS updates', description: 'Send quotes, appointment details, and payment links from the shop workspace.' }
  ];

  constructor() {
    const query = this.route.snapshot.queryParamMap;
    if (String(query.get('invoiceId') || '').trim()) {
      void this.router.navigate(['/invoice-payment'], {
        queryParams: query.keys.reduce<Record<string, string>>((params, key) => {
          params[key] = String(query.get(key) || '');
          return params;
        }, {}),
        replaceUrl: true
      });
    }
  }

  openLogin(): void {
    const target = this.auth.isAuthenticated() ? '/dashboard' : '/login';
    void this.router.navigateByUrl(target);
  }
}
