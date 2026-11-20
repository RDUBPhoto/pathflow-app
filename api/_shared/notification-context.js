const TYPES = new Set(['invoice', 'quote', 'customer', 'lead', 'workitem', 'job', 'email', 'sms']);
const text = value => String(value ?? '').trim();

function notificationContexts(values) {
  if (!Array.isArray(values) || !values.length || values.length > 20) return [];
  const result = [];
  for (const value of values) {
    const type = text(value?.type).toLowerCase();
    const id = text(value?.id);
    if (!TYPES.has(type) || !id || id.length > 256) return [];
    result.push({ type, id, number: text(value.number) });
  }
  return result;
}

function matchesNotificationContext(notification, context) {
  const type = text(notification.entityType).toLowerCase();
  const metadata = notification.metadata || {};
  let route;
  try { route = new URL(text(notification.route), 'https://pathflow.invalid'); } catch { return false; }
  const segments = route.pathname.split('/').filter(Boolean).map(value => {
    try { return decodeURIComponent(value); } catch { return value; }
  });
  const entityId = type === context.type || (context.type === 'workitem' && type === 'item') ? text(notification.entityId) : '';
  if (context.type === 'invoice' || context.type === 'quote') {
    if (['invoice', 'quote'].includes(type) && type !== context.type) return false;
    if (metadata.documentType && metadata.documentType !== context.type) return false;
    const field = `${context.type}Id`;
    const pathType = context.type === 'invoice' ? 'invoices' : 'quotes';
    const ids = [entityId, metadata[field], metadata.documentId,
      segments[0] === pathType ? segments[1] : '', route.searchParams.get(field)].map(text).filter(Boolean);
    // Explicit document IDs take precedence over numbers and customer information.
    if (ids.length) return ids.every(id => id === context.id || (!!context.number && id === context.number));
    const numbers = [metadata[`${context.type}Number`], metadata.documentNumber,
      route.searchParams.get(`${context.type}Number`)].map(text).filter(Boolean);
    return !!context.number && numbers.some(value => value.toLowerCase() === context.number.toLowerCase());
  }
  if (context.type === 'customer') {
    // Viewing a profile does not imply viewing all of its invoices or messages.
    if (!['customer', 'lead'].includes(type)) return false;
    return [entityId, metadata.customerId, type === 'lead' ? notification.entityId : '',
      segments[0] === 'customers' ? segments[1] : ''].map(text).includes(context.id);
  }
  const metadataField = { lead: 'leadItemId', workitem: 'workItemId', job: 'jobId', email: 'emailId', sms: 'smsId' }[context.type];
  return [entityId, metadata[metadataField],
    context.type === 'workitem' ? metadata.leadItemId : ''].map(text).includes(context.id);
}

module.exports = { notificationContexts, matchesNotificationContext };
