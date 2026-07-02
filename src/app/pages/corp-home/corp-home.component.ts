import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, OnDestroy, inject } from '@angular/core';
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
export default class CorpHomeComponent implements AfterViewInit, OnDestroy {
  readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private observer: IntersectionObserver | null = null;

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

  ngAfterViewInit(): void {
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
      return;
    }
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('visible');
        this.observer?.unobserve(entry.target);
      }
    }, { threshold: 0.16 });
    document.querySelectorAll('.reveal').forEach(el => this.observer?.observe(el));
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
