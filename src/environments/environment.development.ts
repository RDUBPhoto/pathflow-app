export const environment = {
  apiBase: 'https://wonderful-glacier-0f45f5110.6.azurestaticapps.net',
  publicAppUrl: 'https://wonderful-glacier-0f45f5110.6.azurestaticapps.net',
  features: {
    demoTools: true
  },
  auth: {
    primaryProvider: 'aad',
    providers: ['aad', 'google'],
    adminEmails: ['admin.local@yourcompany.dev'],
    devBypass: true,
    localPasswordEnabled: true,
    localUsers: [
      {
        email: 'admin@yourcompany.local',
        password: 'Admin123!',
        role: 'admin',
        displayName: 'Local Admin'
      },
      {
        email: 'user@yourcompany.local',
        password: 'User123!',
        role: 'user',
        displayName: 'Local User'
      }
    ] as Array<{
      email: string;
      password: string;
      role: 'admin' | 'user';
      displayName?: string;
      avatarUrl?: string;
      phone?: string;
    }>
  }
};
