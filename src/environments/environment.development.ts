export const environment = {
  apiBase: 'http://localhost:4200',
  publicAppUrl: 'http://localhost:4200',
  features: {
    demoTools: true,
    powerBiReports: false
  },
  telemetry: {
    enabled: false,
    endpoint: '/api/telemetry'
  },
  auth: {
    primaryProvider: 'local',
    providers: ['local', 'google', 'aad'],
    hostedEmailEnabled: false,
    hostedEmailProvider: '',
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
        email: 'superadmin@yourcompany.local',
        password: 'Super123!',
        role: 'admin',
        isSuperAdmin: true,
        displayName: 'Local Super Admin'
      },
      {
        email: 'robert@pathflow-app.com',
        password: 'Pathflow123!',
        role: 'admin',
        isSuperAdmin: true,
        displayName: 'Robert Super Admin'
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
      isSuperAdmin?: boolean;
      displayName?: string;
      avatarUrl?: string;
      phone?: string;
    }>
  }
};
