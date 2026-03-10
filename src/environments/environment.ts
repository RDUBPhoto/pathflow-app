export const environment = {
  apiBase: '',
  publicAppUrl: 'https://wonderful-glacier-0f45f5110.6.azurestaticapps.net',
  features: {
    demoTools: false
  },
  auth: {
    primaryProvider: 'aad',
    providers: ['aad'],
    hostedEmailEnabled: false,
    hostedEmailProvider: '',
    adminEmails: [] as string[],
    devBypass: false,
    localPasswordEnabled: false,
    localUsers: [] as Array<{
      email: string;
      password: string;
      role: 'admin' | 'user';
      isSuperAdmin?: boolean;
      displayName?: string;
      avatarUrl?: string;
    }>
  }
};
