export const environment = {
  apiBase: '',
  publicAppUrl: 'https://www.pathflow-app.com',
  features: {
    demoTools: false,
    powerBiReports: false
  },
  auth: {
    primaryProvider: 'local',
    providers: ['local', 'aad', 'google'],
    hostedEmailEnabled: false,
    hostedEmailProvider: '',
    adminEmails: [] as string[],
    devBypass: false,
    localPasswordEnabled: true,
    localUsers: [] as Array<{
      email: string;
      password: string;
      role: 'admin' | 'user';
      isSuperAdmin?: boolean;
      displayName?: string;
      avatarUrl?: string;
      phone?: string;
    }>
  }
};
