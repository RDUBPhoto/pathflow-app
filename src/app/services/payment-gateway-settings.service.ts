import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AppSettingsApiService } from './app-settings-api.service';

export type PaymentGatewayProviderKey = 'authorize-net' | 'stripe' | 'paypal';

export type PaymentGatewayProvider = {
  key: PaymentGatewayProviderKey;
  label: string;
  connected: boolean;
  accountLabel: string;
  mode: 'test' | 'live';
  updatedAt: string;
};

export type PaymentGatewaySettings = {
  defaultProvider: PaymentGatewayProviderKey | null;
  providers: PaymentGatewayProvider[];
};

type PaymentLinkAvailability = {
  enabled: boolean;
  provider: PaymentGatewayProvider | null;
  reason: string;
};

const PAYMENT_GATEWAY_SETTINGS_KEY = 'billing.paymentProviders';

const DEFAULT_PROVIDERS: PaymentGatewayProvider[] = [
  {
    key: 'authorize-net',
    label: 'Authorize.net',
    connected: false,
    accountLabel: '',
    mode: 'test',
    updatedAt: ''
  },
  {
    key: 'stripe',
    label: 'Stripe',
    connected: false,
    accountLabel: '',
    mode: 'test',
    updatedAt: ''
  },
  {
    key: 'paypal',
    label: 'PayPal',
    connected: false,
    accountLabel: '',
    mode: 'test',
    updatedAt: ''
  }
];

@Injectable({ providedIn: 'root' })
export class PaymentGatewaySettingsService {
  private readonly settingsApi = inject(AppSettingsApiService);
  private readonly state = signal<PaymentGatewaySettings>(this.defaultSettings());

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly loadError = signal('');

  readonly settings = computed(() => this.state());
  readonly providers = computed(() => this.state().providers);
  readonly connectedProviders = computed(() => this.providers().filter(provider => provider.connected));
  readonly defaultProvider = computed(() => {
    const settings = this.state();
    const connected = settings.providers.filter(provider => provider.connected);
    if (!connected.length) return null;
    if (settings.defaultProvider) {
      const selected = connected.find(provider => provider.key === settings.defaultProvider);
      if (selected) return selected;
    }
    return connected[0] || null;
  });
  readonly paymentLinkAvailability = computed<PaymentLinkAvailability>(() => {
    const provider = this.defaultProvider();
    if (provider) {
      return {
        enabled: true,
        provider,
        reason: ''
      };
    }
    return {
      enabled: false,
      provider: null,
      reason: 'Need to connect your payment provider'
    };
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set('');
    try {
      const raw = await firstValueFrom(
        this.settingsApi.getValue<PaymentGatewaySettings>(PAYMENT_GATEWAY_SETTINGS_KEY)
      );
      this.state.set(this.normalizeSettings(raw));
    } catch {
      this.loadError.set('Could not load payment gateway settings.');
      this.state.set(this.defaultSettings());
    } finally {
      this.loading.set(false);
    }
  }

  providerByKey(key: PaymentGatewayProviderKey): PaymentGatewayProvider {
    return this.providers().find(provider => provider.key === key) || this.defaultProviderByKey(key);
  }

  async setConnection(
    key: PaymentGatewayProviderKey,
    connected: boolean,
    options?: {
      accountLabel?: string;
      mode?: 'test' | 'live';
      setAsDefault?: boolean;
    }
  ): Promise<void> {
    const previous = this.state();
    const now = new Date().toISOString();
    const nextProviders = previous.providers.map(provider => {
      if (provider.key !== key) return provider;
      return {
        ...provider,
        connected,
        accountLabel: (options?.accountLabel ?? provider.accountLabel).trim(),
        mode: options?.mode ?? provider.mode,
        updatedAt: now
      };
    });

    let nextDefault = previous.defaultProvider;
    if (connected && options?.setAsDefault) nextDefault = key;
    if (!connected && nextDefault === key) nextDefault = null;

    const next = this.ensureDefault({
      defaultProvider: nextDefault,
      providers: nextProviders
    });

    await this.persistSettings(next, previous);
  }

  async setDefaultProvider(key: PaymentGatewayProviderKey | null): Promise<void> {
    const previous = this.state();
    const next = this.ensureDefault({
      defaultProvider: key,
      providers: previous.providers
    });
    await this.persistSettings(next, previous);
  }

  async updateProvider(
    key: PaymentGatewayProviderKey,
    patch: {
      accountLabel?: string;
      mode?: 'test' | 'live';
    }
  ): Promise<void> {
    const previous = this.state();
    const now = new Date().toISOString();
    const next = this.ensureDefault({
      defaultProvider: previous.defaultProvider,
      providers: previous.providers.map(provider => {
        if (provider.key !== key) return provider;
        return {
          ...provider,
          accountLabel: patch.accountLabel !== undefined ? patch.accountLabel.trim() : provider.accountLabel,
          mode: patch.mode ?? provider.mode,
          updatedAt: now
        };
      })
    });
    await this.persistSettings(next, previous);
  }

  createHostedPaymentLink(invoiceId: string, invoiceNumber: string): string | null {
    const provider = this.defaultProvider();
    if (!provider) return null;
    const id = encodeURIComponent(String(invoiceId || '').trim());
    const number = encodeURIComponent(String(invoiceNumber || '').trim());
    return `https://pay.pathflow.com/${provider.key}/checkout?invoiceId=${id}&invoice=${number}`;
  }

  private async persistSettings(next: PaymentGatewaySettings, rollback: PaymentGatewaySettings): Promise<void> {
    this.saving.set(true);
    this.state.set(next);
    try {
      await firstValueFrom(this.settingsApi.setValue(PAYMENT_GATEWAY_SETTINGS_KEY, next));
    } catch {
      this.state.set(rollback);
      throw new Error('Could not save payment gateway settings.');
    } finally {
      this.saving.set(false);
    }
  }

  private normalizeSettings(value: unknown): PaymentGatewaySettings {
    if (!value || typeof value !== 'object') return this.defaultSettings();
    const source = value as Partial<PaymentGatewaySettings>;
    const list = Array.isArray(source.providers) ? source.providers : [];

    const providers: PaymentGatewayProvider[] = DEFAULT_PROVIDERS.map(fallback => {
      const match = list.find(item => item && item.key === fallback.key);
      if (!match || typeof match !== 'object') return { ...fallback };
      return {
        key: fallback.key,
        label: String(match.label || fallback.label).trim() || fallback.label,
        connected: !!match.connected,
        accountLabel: String(match.accountLabel || '').trim(),
        mode: match.mode === 'live' ? 'live' : 'test',
        updatedAt: String(match.updatedAt || '').trim()
      };
    });

    const defaultProvider = this.isProviderKey(source.defaultProvider) ? source.defaultProvider : null;
    return this.ensureDefault({
      defaultProvider,
      providers
    });
  }

  private ensureDefault(settings: PaymentGatewaySettings): PaymentGatewaySettings {
    const connected = settings.providers.filter(provider => provider.connected);
    if (!connected.length) {
      return {
        defaultProvider: null,
        providers: settings.providers
      };
    }

    if (settings.defaultProvider) {
      const defaultConnected = connected.some(provider => provider.key === settings.defaultProvider);
      if (defaultConnected) return settings;
    }

    return {
      defaultProvider: connected[0].key,
      providers: settings.providers
    };
  }

  private defaultProviderByKey(key: PaymentGatewayProviderKey): PaymentGatewayProvider {
    return DEFAULT_PROVIDERS.find(provider => provider.key === key) || DEFAULT_PROVIDERS[0];
  }

  private defaultSettings(): PaymentGatewaySettings {
    return {
      defaultProvider: null,
      providers: DEFAULT_PROVIDERS.map(provider => ({ ...provider }))
    };
  }

  private isProviderKey(value: unknown): value is PaymentGatewayProviderKey {
    return value === 'authorize-net' || value === 'stripe' || value === 'paypal';
  }
}
