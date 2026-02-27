export const environment = {
  apiBase: '',
  publicAppUrl: 'https://wonderful-glacier-0f45f5110.6.azurestaticapps.net',
  auth: {
    primaryProvider: 'aad',
    providers: ['aad', 'google'],
    adminEmails: [] as string[],
    devBypass: false,
    localPasswordEnabled: true,
    localUsers: [] as Array<{
      email: string;
      password: string;
      role: 'admin' | 'user';
      displayName?: string;
      avatarUrl?: string;
    }>
  }
};
