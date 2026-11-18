// In-place change of the existing database only. No server, login, data,
// firewall, or connection-string changes. Approved 2026-10-09.
targetScope = 'resourceGroup'

resource server 'Microsoft.Sql/servers@2023-08-01' existing = {
  name: 'pathflow-sql-prod'
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: server
  name: 'free-sql-db-6716999'
  location: 'centralus'
  sku: {
    name: 'S0'
    tier: 'Standard'
    capacity: 10
  }
  properties: {
    // S0 includes 250 GiB. The former serverless 32 GiB limit is not an allowed S0 size.
    maxSizeBytes: 268435456000
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    requestedBackupStorageRedundancy: 'Local'
    zoneRedundant: false
    readScale: 'Disabled'
    useFreeLimit: false
  }
}

output databaseId string = database.id
