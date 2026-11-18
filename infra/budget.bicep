targetScope = 'subscription'
@description('Owner email receiving cost alerts. Budget alerts do not stop services or cap spending.')
param contactEmail string
param startDate string = '2026-10-01T00:00:00Z'

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'pathflow-monthly-50'
  properties: {
    amount: 50
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    notifications: {
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [contactEmail]
      }
      actual100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: [contactEmail]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [contactEmail]
      }
    }
  }
}
