targetScope = 'resourceGroup'
resource server 'Microsoft.Sql/servers@2023-08-01' existing = {
  name: 'pathflow-sql-prod'
}
// Empty, isolated development database. Never copy production customer data here.
resource database 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: server
  name: 'pathflow-dev'
  location: 'centralus'
  sku: { name: 'Basic', tier: 'Basic', capacity: 5 }
  properties: {
    maxSizeBytes: 2147483648
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    requestedBackupStorageRedundancy: 'Local'
    zoneRedundant: false
    readScale: 'Disabled'
  }
}
