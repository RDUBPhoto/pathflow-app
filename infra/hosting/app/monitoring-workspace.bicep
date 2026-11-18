param name string
param location string
param tags object = {}
param dataRetention int = 30
// Bicep lacks decimal parameters; ARM expects a JSON number.
param dailyQuotaGb string = '0.05'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: dataRetention
    workspaceCapping: { dailyQuotaGb: json(dailyQuotaGb) }
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}
output resourceId string = workspace.id
