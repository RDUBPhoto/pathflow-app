export const environment = {
  apiBase: '',
  publicAppUrl: 'https://happy-desert-01944f00f.1.azurestaticapps.net',
  auth: {
    primaryProvider: 'aad',
    providers: ['aad', 'google'],
    adminEmails: [] as string[],
    devBypass: false,
    localPasswordEnabled: false,
    localUsers: [] as Array<{
      email: string;
      password: string;
      role: 'admin' | 'user';
      displayName?: string;
      avatarUrl?: string;
    }>
  }
};
