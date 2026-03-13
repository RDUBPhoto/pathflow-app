import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { IonButton, IonContent } from '@ionic/angular/standalone';
import { AuthService } from '../../auth/auth.service';

@Component({
  selector: 'app-corp-home',
  standalone: true,
  imports: [CommonModule, RouterLink, IonContent, IonButton],
  templateUrl: './corp-home.component.html',
  styleUrls: ['./corp-home.component.scss']
})
export default class CorpHomeComponent {
  readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  constructor() {
    const qp = this.route.snapshot.queryParamMap;
    const hasInvoiceQuery = !!String(qp.get('invoiceId') || '').trim();
    if (hasInvoiceQuery) {
      void this.router.navigate(['/invoice-payment'], {
        queryParams: qp.keys.reduce<Record<string, string>>((acc, key) => {
          acc[key] = String(qp.get(key) || '');
          return acc;
        }, {}),
        replaceUrl: true
      });
    }
  }

  openLogin(): void {
    const target = this.auth.isAuthenticated() ? '/dashboard' : '/login';
    window.location.assign(target);
  }
}
