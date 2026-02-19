export const environment = {
  apiBase: 'https://wonderful-glacier-0f45f5110.6.azurestaticapps.net',
  publicAppUrl: 'https://wonderful-glacier-0f45f5110.6.azurestaticapps.net',
  auth: {
    primaryProvider: 'aad',
    providers: ['aad', 'google'],
    adminEmails: ['admin.local@exodus4x4.dev'],
    devBypass: true,
    localPasswordEnabled: true,
    localUsers: [
      {
        email: 'admin@exodus.local',
        password: 'Admin123!',
        role: 'admin',
        displayName: 'Local Admin'
      },
      {
        email: 'user@exodus.local',
        password: 'User123!',
        role: 'user',
        displayName: 'Local User'
      }
    ]
  }
};
