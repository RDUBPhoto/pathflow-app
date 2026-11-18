const https = require("https");
const { gatewayConfig, hasNoCardSurcharge, chargeNonce, invoiceCheckoutProvider } = require("../_shared/paylynx");
const { acquireInvoicePaymentLock } = require("../_shared/invoice-payment-lock");
const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { resolveTenantId } = require("../_shared/tenant");
const { resolveStaff } = require("../_shared/staff-access");
const { recordInvoicePayment, invoiceBalance, invoicePreviouslyPaid, invoicePublishedTotal, getEntityIfExists, paymentAttemptKey } = require("../invoice-response");
const { sendOutboundEmail } = require("../email");
const { isPortalToken, portalTokenFromHeader, allowsPortalAction } = require("../_shared/customer-portal");

const SETTINGS_TABLE = "appsettings";
const INVOICES_TABLE = "invoiceresponses";
const ATTEMPTS_TABLE = "invoicepaymentattempts";
const PAYMENT_GATEWAY_SETTINGS_KEY = "billing.paymentProviders";
const AUTHORIZE_NET_CREDENTIALS_KEY = "billing.paymentProviders.authorizeNetCredentials";
const chargeErrors = {
  permission: "PayLynx rejected the gateway credentials or Charge permission.",
  card_token: "The card session expired. Enter the card details again.",
  security_code: "The security code did not match. Check the card and try again.",
  rejected: "PayLynx rejected this card payment. Check the card details or try another card.",
  declined: "The card was declined. Try a different card or contact the card issuer."
};

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return {};
}

function normalizeRawSource(raw) {
  return String(raw == null ? "" : raw).replace(/^\uFEFF/, "").trim();
}

function decodeXmlEntities(value) {
  return asString(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeXmlSource(raw) {
  const source = normalizeRawSource(raw);
  // Trim BOM + leading whitespace so XML detection is resilient.
  return source.trimStart();
}

function firstTagValue(xml, tagName) {
  const source = normalizeXmlSource(xml);
  const tag = asString(tagName);
  if (!source || !tag) return "";
  const pattern = new RegExp(`<(?:[a-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-z0-9_]+:)?${tag}>`, "i");
  const match = source.match(pattern);
  return decodeXmlEntities(match && match[1] ? match[1] : "");
}

function parseAuthorizeXml(raw) {
  const xml = normalizeXmlSource(raw);
  if (!xml || xml[0] !== "<") return {};

  const resultCode = firstTagValue(xml, "resultCode");
  const messageCode = firstTagValue(xml, "code");
  const messageText = firstTagValue(xml, "text");
  const responseCode = firstTagValue(xml, "responseCode");
  const responseReasonCode = firstTagValue(xml, "responseReasonCode");
  const responseReasonDescription = firstTagValue(xml, "responseReasonDescription");
  const transId = firstTagValue(xml, "transId");
  const authCode = firstTagValue(xml, "authCode");
  const avsResultCode = firstTagValue(xml, "avsResultCode");
  const accountType = firstTagValue(xml, "accountType");
  const accountNumber = firstTagValue(xml, "accountNumber");
  const errorCode = firstTagValue(xml, "errorCode");
  const errorText = firstTagValue(xml, "errorText");

  const out = {
    messages: {
      resultCode: resultCode || "",
      message: messageCode || messageText
        ? [{ code: messageCode || "", text: messageText || "" }]
        : []
    },
    transactionResponse: {
      responseCode: responseCode || "",
      responseReasonCode: responseReasonCode || "",
      responseReasonDescription: responseReasonDescription || "",
      transId: transId || "",
      authCode: authCode || "",
      avsResultCode: avsResultCode || "",
      accountType: accountType || "",
      accountNumber: accountNumber || "",
      errors: errorCode || errorText
        ? [{ errorCode: errorCode || "", errorText: errorText || "" }]
        : []
    }
  };

  const hasSignal =
    asString(out.messages.resultCode)
    || asString(out.transactionResponse.responseCode)
    || asString(out.transactionResponse.transId)
    || asString(out.transactionResponse.responseReasonDescription)
    || (Array.isArray(out.transactionResponse.errors) && out.transactionResponse.errors.length > 0);
  if (!hasSignal) return {};
  return out;
}

function parseAuthorizeRaw(raw) {
  const source = normalizeRawSource(raw);
  if (!source) return {};
  if (source[0] === "{") {
    try {
      return asObject(JSON.parse(source));
    } catch {
      return {};
    }
  }
  if (source[0] === "<") {
    return parseAuthorizeXml(source);
  }
  return {};
}

function normalizeAuthorizeResult(body) {
  let result = asObject(body);
  const wrapped = asObject(result && result.createTransactionResponse);
  if (Object.keys(wrapped).length) {
    result = wrapped;
  }

  const messages = asObject(result && result.messages);
  const tx = asObject(result && result.transactionResponse);
  const hasCoreFields =
    !!asString(messages.resultCode)
    || !!asString(tx.responseCode)
    || !!asString(tx.transId);

  if (!hasCoreFields) {
    const raw = asString(result && result.raw);
    if (raw) {
      const rawParsed = parseAuthorizeRaw(raw);
      if (Object.keys(rawParsed).length) {
        const wrappedRaw = asObject(rawParsed.createTransactionResponse);
        result = Object.keys(wrappedRaw).length ? wrappedRaw : rawParsed;
      }
    }
  }

  return result;
}

function parseValue(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body
  };
}

function sanitizeAmount(value) {
  const normalized = asString(value).replace(/[^0-9.\-]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function onlyDigits(value) {
  return asString(value).replace(/\D+/g, "");
}

function sanitizeMonth(value) {
  const month = Number(onlyDigits(value));
  if (!Number.isFinite(month) || month < 1 || month > 12) return "";
  return String(month).padStart(2, "0");
}

function sanitizeYear(value) {
  const digits = onlyDigits(value);
  if (digits.length === 2) return `20${digits}`;
  if (digits.length === 4) return digits;
  return "";
}

function splitCardholderName(value) {
  const raw = asString(value);
  if (!raw) return { firstName: "Customer", lastName: "" };
  const parts = raw.split(/\s+/g).filter(Boolean);
  if (!parts.length) return { firstName: "Customer", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1]
  };
}

async function getTableClient(tableName) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn && !isSqlBackendEnabled()) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn || "sql-backend", tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function getSettingValue(client, tenantId, key) {
  try {
    const entity = await client.getEntity(asString(tenantId), asString(key));
    return parseValue(entity.valueJson);
  } catch {
    return null;
  }
}

function resolveAuthorizeProvider(paymentSettings) {
  const source = asObject(paymentSettings);
  const providers = Array.isArray(source.providers) ? source.providers : [];
  const authorize = providers.find(item => asString(item && item.key).toLowerCase() === "authorize-net");
  if (!authorize || typeof authorize !== "object") {
    return { connected: false, mode: "test" };
  }
  return {
    connected: !!authorize.connected,
    mode: asString(authorize.mode).toLowerCase() === "live" ? "live" : "test"
  };
}

function resolveCredentials(rawCredentials) {
  const source = asObject(rawCredentials);
  const apiLoginId = asString(source.apiLoginId || process.env.AUTHORIZE_NET_API_LOGIN_ID);
  const transactionKey = asString(source.transactionKey || process.env.AUTHORIZE_NET_TRANSACTION_KEY);
  return { apiLoginId, transactionKey };
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error("Invalid payment endpoint URL."));
      return;
    }

    const data = JSON.stringify(payload);
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data)
        },
        timeout: 15000
      },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            const normalized = normalizeRawSource(raw);
            parsed = normalized ? JSON.parse(normalized) : {};
          } catch {
            const rawParsed = parseAuthorizeRaw(raw);
            parsed = Object.keys(rawParsed).length ? rawParsed : { raw };
          }
          resolve({
            status: Number(res.statusCode || 0),
            body: parsed
          });
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Payment provider timeout."));
    });
    req.write(data);
    req.end();
  });
}

function pickAuthorizeError(responseBody) {
  const tx = responseBody && responseBody.transactionResponse;
  const txErrors = Array.isArray(tx && tx.errors) ? tx.errors : [];
  if (txErrors.length) {
    const first = txErrors[0] || {};
    const code = asString(first.errorCode);
    const text = asString(first.errorText);
    return [code, text].filter(Boolean).join(": ") || "Payment was declined or could not be processed.";
  }

  const messages = responseBody && responseBody.messages;
  const list = Array.isArray(messages && messages.message) ? messages.message : [];
  if (list.length) {
    const first = list[0] || {};
    const code = asString(first.code);
    const text = asString(first.text || first.description);
    return [code, text].filter(Boolean).join(": ") || "Payment was declined or could not be processed.";
  }

  const responseCode = asString(tx && tx.responseCode);
  const responseText = asString(tx && tx.responseReasonDescription);
  if (responseCode || responseText) {
    return [responseCode, responseText].filter(Boolean).join(": ");
  }

  const raw = asString(responseBody && responseBody.raw);
  const parsedRaw = parseAuthorizeRaw(raw);
  const rawWrapped = asObject(parsedRaw && parsedRaw.createTransactionResponse);
  const rawSource = Object.keys(rawWrapped).length ? rawWrapped : asObject(parsedRaw);
  const rawTx = asObject(rawSource && rawSource.transactionResponse);
  const rawMessages = asObject(rawSource && rawSource.messages);
  const rawList = Array.isArray(rawMessages.message) ? rawMessages.message : [];
  const rawMessage = asObject(rawList[0]);
  const rawReason = [
    asString(rawTx.responseReasonDescription),
    asString(rawTx.responseCode),
    asString(rawMessage.text || rawMessage.description)
  ].find(Boolean);
  if (rawReason) return rawReason;

  return "Payment was declined or could not be processed.";
}

async function chargeAuthorizeNet(endpoint, credentials, details) {
  const name = splitCardholderName(details.cardholderName);
  const payload = {
    createTransactionRequest: {
      merchantAuthentication: {
        name: credentials.apiLoginId,
        transactionKey: credentials.transactionKey
      },
      refId: details.attemptKey.slice(0, 20),
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: details.amount.toFixed(2),
        payment: {
          creditCard: {
            cardNumber: details.cardNumber,
            expirationDate: `${details.expiryYear}-${details.expiryMonth}`,
            cardCode: details.cardCode
          }
        },
        order: {
          invoiceNumber: details.invoiceNumber,
          description: `Pathflow invoice ${details.invoiceNumber}`
        },
        billTo: {
          firstName: name.firstName || "Customer",
          lastName: name.lastName || ""
        }
      }
    }
  };

  const response = await postJson(endpoint, payload);
  const result = normalizeAuthorizeResult(response.body);
  const tx = asObject(result.transactionResponse);
  const responseCode = asString(tx.responseCode);
  const transactionId = asString(tx.transId);
  const validResponse = response.status >= 200 && response.status < 300;
  if (!validResponse || responseCode !== "1" || !/^[1-9]\d*$/.test(transactionId) || tx.errors?.length) {
    return validResponse && (responseCode === "2" || (responseCode === "3" && (!transactionId || transactionId === "0")))
      ? { state: "declined", error: pickAuthorizeError(result) } : { state: "pending" };
  }
  return { state: "confirmed", transactionId, accountNumber: asString(tx.accountNumber).replace(/\D/g, "").slice(-4) };
}

function staffPaymentSnapshot(document, invoice, tenantId, invoiceId) {
  const total = sanitizeAmount(document.total);
  return {
    ...invoice,
    partitionKey: tenantId, rowKey: invoiceId, invoiceId,
    invoiceNumber: document.invoiceNumber, customerName: document.customerName,
    customerEmail: document.customerEmail, vehicle: document.vehicle, businessName: document.businessName,
    dueDate: document.dueDate, snapshotPaymentProvider: "paylynx",
    invoiceDataJson: JSON.stringify({
      jobNumber: document.jobNumber, customerId: document.customerId, subtotal: document.subtotal,
      taxTotal: document.taxTotal, total: total + sanitizeAmount(document.returnCreditAmount), lineItems: document.lineItems
    }),
    amount: Math.max(0, total - sanitizeAmount(document.paidAmount)).toFixed(2)
  };
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "POST";
  const body = asObject(req && req.body);
  const tenantId = resolveTenantId(req, body);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  if (method !== "POST" && method !== "GET") {
    context.res = json(405, { ok: false, error: "Method not allowed." });
    return;
  }

  const input = method === "GET" ? req.query : body;
  const invoiceId = asString(input?.invoiceId || input?.id);
  const publicToken = portalTokenFromHeader(req.headers) || asString(input?.publicToken);
  const staffCharge = input?.staffCharge === true || (method === "GET" && input?.staffCharge === "true");
  const requestedAmount = sanitizeAmount(body.amount);
  if (!invoiceId) {
    context.res = json(400, { ok: false, error: "invoiceId is required." });
    return;
  }
  if ((!staffCharge && !publicToken) || (method === "POST" && !requestedAmount)) {
    context.res = json(400, { ok: false, error: "Open the latest payment link to pay this invoice." });
    return;
  }

  let releasePaymentLock;
  let chargeAttempted = false;
  try {
    let actor;
    if (staffCharge) {
      const staff = await resolveStaff(req, await getTableClient("useraccess"), tenantId);
      if (!staff.authorized) {
        context.res = json(staff.actor ? 403 : 401, { ok: false, error: "A staff session is required to enter a card payment." });
        return;
      }
      actor = staff.actor;
    }
    const invoiceClient = await getTableClient(INVOICES_TABLE);
    let invoice = await getEntityIfExists(invoiceClient, tenantId, invoiceId);
    const canUsePaymentLink = async () => invoice && (isPortalToken(publicToken)
      ? await allowsPortalAction(tenantId, publicToken, "invoice", invoiceId)
      : invoice.publicToken === publicToken);
    if (!staffCharge && !await canUsePaymentLink()) {
      context.res = json(404, { ok: false, error: "Invoice not found or payment link is invalid." });
      return;
    }
    const attempts = method === "POST" ? await getTableClient(ATTEMPTS_TABLE) : null;
    if (attempts) {
      releasePaymentLock = await acquireInvoicePaymentLock(attempts, tenantId, invoiceId);
      if (!releasePaymentLock) {
        context.res = json(409, { ok: false, code: "payment_pending", error: "A payment action is already in progress for this invoice." });
        return;
      }
      invoice = await getEntityIfExists(invoiceClient, tenantId, invoiceId);
      if (!staffCharge && !await canUsePaymentLink()) {
        context.res = json(404, { ok: false, error: "Invoice not found or payment link is invalid." });
        return;
      }
      if (invoice?.pendingReversal) {
        context.res = json(409, { ok: false, code: "payment_pending", error: "An invoice payment reversal is awaiting confirmation. Check the invoice before charging again." });
        return;
      }
    }
    const settingsClient = await getTableClient(SETTINGS_TABLE);
    const paymentSettings = await getSettingValue(settingsClient, tenantId, PAYMENT_GATEWAY_SETTINGS_KEY);
    const provider = invoiceCheckoutProvider(invoice || {}, paymentSettings, tenantId);
    if (staffCharge && provider !== "paylynx") {
      context.res = json(503, { ok: false, error: "Set PayLynx as the invoice gateway to enter a card payment here." });
      return;
    }
    if (provider !== "paylynx" && (provider !== "authorize-net" || method === "GET")) {
      context.res = json(404, { ok: false, error: "Invoice not found or payment link is invalid." });
      return;
    }

    let needsStaffSnapshot = false;
    if (staffCharge) {
      const row = await getEntityIfExists(await getTableClient("servicedocuments"), tenantId, invoiceId);
      const document = asObject(parseValue(row?.documentJson));
      if (!row || row.deleted || document.documentType !== "invoice" || ["canceled", "expired", "declined"].includes(document.stage)) {
        context.res = json(404, { ok: false, error: "This saved invoice is unavailable for a card payment." });
        return;
      }
      needsStaffSnapshot = !invoice?.invoiceDataJson;
      if (needsStaffSnapshot) invoice = staffPaymentSnapshot(document, invoice, tenantId, invoiceId);
      else if (Math.round((sanitizeAmount(document.total) + sanitizeAmount(document.returnCreditAmount) -
          sanitizeAmount(invoice.returnCreditAmount)) * 100) !== Math.round(invoicePublishedTotal(invoice) * 100)) {
        context.res = json(409, { ok: false, code: "balance_changed", error: "The saved total differs from the checkout total. Send the updated invoice before charging it." });
        return;
      }
    }

    const source = asString(body.source);
    const expiryMonth = sanitizeMonth(body.expiryMonth);
    const expiryYear = sanitizeYear(body.expiryYear);
    const cardholderName = provider === "paylynx"
      ? asString(invoice.customerName) || "Customer"
      : asString(body.cardholderName || body.customerName || "Customer");
    const billingZip = asString(body.billingZip).slice(0, 10);
    const cardNumber = onlyDigits(body.cardNumber);
    const cardCode = onlyDigits(body.cardCode);
    if (method === "POST") {
      if (!expiryMonth || !expiryYear) {
        context.res = json(400, { ok: false, error: "Valid expiration month/year are required." });
        return;
      }
      if (provider === "paylynx" && (!/^nonce-[A-Za-z0-9]{1,20}$/.test(source) || body.cardNumber || body.cardCode)) {
        context.res = json(400, { ok: false, error: "Enter your card in the PayLynx secure card fields." });
        return;
      }
      if (provider === "authorize-net" && (cardNumber.length < 13 || cardNumber.length > 19 || cardCode.length < 3 || cardCode.length > 4)) {
        context.res = json(400, { ok: false, error: "Valid card number and card code are required." });
        return;
      }
    }

    const paylynxProvider = Array.isArray(paymentSettings?.providers)
      ? paymentSettings.providers.find(item => item?.key === "paylynx")
      : null;
    const paylynx = provider === "paylynx" && paylynxProvider?.connected === true
      ? gatewayConfig(tenantId, paylynxProvider.mode) : null;
    if (provider === "paylynx" && !paylynx) {
      context.res = json(503, { ok: false, error: "PayLynx checkout is unavailable. Contact the shop." });
      return;
    }
    if (method === "GET") {
      const attempt = invoiceBalance(invoice) > 0
        ? await getEntityIfExists(await getTableClient(ATTEMPTS_TABLE), tenantId, paymentAttemptKey(invoiceId, invoice))
        : null;
      const paymentPending = Boolean(invoice.pendingReversal || (attempt && attempt.state !== "confirmed"));
      const snapshot = staffCharge ? {
        invoiceId, invoiceNumber: invoice.invoiceNumber, invoiceData: parseValue(invoice.invoiceDataJson),
        customerName: invoice.customerName, vehicle: invoice.vehicle, businessName: invoice.businessName,
        dueDate: invoice.dueDate, paymentProvider: "paylynx", amount: invoiceBalance(invoice),
        paidAmount: invoicePreviouslyPaid(invoice), returnCreditAmount: Number(invoice.returnCreditAmount || 0)
      } : {};
      context.res = json(200, { ok: true, tokenizationKey: paylynx.tokenizationKey, mode: paylynx.mode, ...snapshot,
        ...(paymentPending ? { paymentPending: true } : {}) });
      return;
    }

    const invoiceNumber = asString(invoice.invoiceNumber || invoiceId);
    const invoiceData = asObject(parseValue(invoice.invoiceDataJson));
    const amount = invoiceBalance(invoice);
    const paid = invoicePreviouslyPaid(invoice);
    // Re-sending the same balance leaves the attempt key stable.
    const attemptKey = paymentAttemptKey(invoiceId, invoice);
    const previousAttempt = await getEntityIfExists(attempts, tenantId, attemptKey);
    if (previousAttempt) {
      if (previousAttempt.state !== "confirmed") {
        context.res = json(409, { ok: false, code: "payment_pending", error: "A payment is awaiting confirmation. Check the payment status before charging again." });
        return;
      }
      const payment = asObject(parseValue(previousAttempt.paymentJson));
      if (payment.paymentProvider !== provider) {
        context.res = json(409, { ok: false, error: "This balance was already paid. Refresh the invoice." });
        return;
      }
      const receiptSent = await finishConfirmedPayment(context, attempts, tenantId, attemptKey, payment, paid, publicToken);
      context.res = json(200, paymentResult(payment, receiptSent));
      return;
    }
    if (amount <= 0 || requestedAmount !== amount) {
      context.res = json(409, { ok: false, code: "balance_changed", error: "The invoice balance changed. Refresh the invoice before paying." });
      return;
    }

    let credentials;
    let endpoint;
    let mode = "test";
    if (paylynx) {
      mode = paylynx.mode;
      if (!await hasNoCardSurcharge(paylynx)) {
        context.res = json(503, { ok: false, code: "surcharge_unavailable", error: "Card checkout is unavailable because PayLynx card fees could not be verified." });
        return;
      }
    } else {
      const authorizeProvider = resolveAuthorizeProvider(paymentSettings);
      if (!authorizeProvider.connected) {
        context.res = json(400, { ok: false, error: "Authorize.net is not connected for this workspace." });
        return;
      }
      const storedCredentials = await getSettingValue(settingsClient, tenantId, AUTHORIZE_NET_CREDENTIALS_KEY);
      credentials = resolveCredentials(storedCredentials);
      if (!credentials.apiLoginId || !credentials.transactionKey) {
        context.res = json(400, { ok: false, error: "Authorize.net credentials are missing. Add API Login ID and Transaction Key in Admin > Payment Gateways." });
        return;
      }
      mode = authorizeProvider.mode;
      endpoint = mode === "live" ? "https://api2.authorize.net/xml/v1/request.api" : "https://apitest.authorize.net/xml/v1/request.api";
    }

    if (needsStaffSnapshot) await invoiceClient.upsertEntity(invoice, "Merge");
    try {
      await attempts.createEntity({
        partitionKey: tenantId, rowKey: attemptKey, invoiceId, state: "processing",
        amount, createdAt: new Date().toISOString()
      });
    } catch (error) {
      if (error.statusCode !== 409) throw error;
      context.res = json(409, { ok: false, error: "A payment is already being processed for this invoice." });
      return;
    }

    const details = { source, amount, cardholderName, expiryMonth, expiryYear, billingZip, invoiceNumber, attemptKey, cardNumber, cardCode };
    chargeAttempted = true;
    const outcome = paylynx
      ? await chargeNonce(paylynx, details)
      : await chargeAuthorizeNet(endpoint, credentials, details);
    if (outcome.state === "declined") {
      await attempts.deleteEntity(tenantId, attemptKey);
      const message = outcome.reason === "permission" && !staffCharge ? "Card checkout is unavailable. Contact the shop." : chargeErrors[outcome.reason];
      context.res = json(outcome.reason === "permission" ? 503 : 400, {
        ok: false, code: outcome.reason || "declined", error: message || outcome.error || chargeErrors.declined, provider
      });
      return;
    }
    if (outcome.state !== "confirmed") {
      context.res = json(409, { ok: false, code: "payment_pending", error: "PayLynx has not confirmed the payment. Check the payment status before charging again." });
      return;
    }

    const payment = {
      mode,
      ...(staffCharge ? { actor: { email: actor.email } } : {}),
      invoiceId,
      invoiceNumber,
      jobNumber: asString(invoiceData.jobNumber),
      customerId: asString(invoiceData.customerId),
      customerName: asString(invoice.customerName),
      customerEmail: asString(invoice.customerEmail),
      vehicle: asString(invoice.vehicle),
      businessName: asString(invoice.businessName),
      lineItems: Array.isArray(invoiceData.lineItems) ? invoiceData.lineItems : [],
      paymentAmount: amount,
      paidAmount: Math.round((paid + amount) * 100) / 100,
      paymentKind: paid > 0 ? "final" : "initial",
      paymentProvider: provider,
      paymentTransactionId: outcome.transactionId,
      paymentAccountNumber: outcome.accountNumber
    };
    await attempts.upsertEntity({ partitionKey: tenantId, rowKey: attemptKey, state: "confirmed",
      paymentJson: JSON.stringify(payment) }, "Merge");
    const receiptSent = await finishConfirmedPayment(context, attempts, tenantId, attemptKey, payment, paid, publicToken);
    context.res = json(200, paymentResult(payment, receiptSent));
  } catch (err) {
    context.log.error("Invoice payment could not be recorded.");
    context.res = json(500, {
      ok: false,
      code: chargeAttempted ? "payment_pending" : "payment_unavailable",
      error: chargeAttempted ? "Payment could not be confirmed. Check the payment status before charging again." : "Payment checkout is unavailable. Try again shortly."
    });
  } finally {
    if (releasePaymentLock) await releasePaymentLock();
  }
};

async function finishConfirmedPayment(context, attempts, tenantId, attemptKey, payment, previouslyPaid, publicToken) {
  if (previouslyPaid <= payment.paidAmount) await recordInvoicePayment(tenantId, payment);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payment.customerEmail || "")) return false;

  const rowKey = `receipt-${attemptKey}`;
  const receipt = { partitionKey: tenantId, rowKey, invoiceId: payment.invoiceId, state: "sending",
    createdAt: new Date().toISOString() };
  try {
    await attempts.createEntity(receipt);
  } catch (error) {
    if (error.statusCode !== 409) {
      context.log.warn("Could not queue the payment receipt.");
      return false;
    }
    return (await getEntityIfExists(attempts, tenantId, rowKey))?.state === "sent";
  }

  try {
    const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    let portalUrl = "";
    if (isPortalToken(publicToken)) {
      const localDevelopment = process.env.PATHFLOW_ENVIRONMENT === "development" && !process.env.WEBSITE_SITE_NAME;
      const base = process.env.PUBLIC_APP_BASE_URL || process.env.APP_BASE_URL ||
        (localDevelopment ? "http://localhost:4200" : "https://www.pathflow-app.com");
      try {
        const url = new URL(`/visit/${encodeURIComponent(tenantId)}#${publicToken}`, base);
        if (["https:", "http:"].includes(url.protocol)) portalUrl = url.href;
      } catch {}
    }
    const sent = await sendOutboundEmail(context, tenantId, {
      to: payment.customerEmail,
      customerName: payment.customerName,
      customerId: payment.customerId,
      subject: `Payment receipt for ${payment.invoiceNumber}`,
      message: `Hi ${payment.customerName || "there"}, ${payment.businessName || "the shop"} received your payment of ${money.format(payment.paymentAmount)} for invoice ${payment.invoiceNumber}. Transaction reference ${payment.paymentTransactionId}.${portalUrl ? ` Your visit: ${portalUrl}` : ""}`,
      skipFooterTerms: true
    });
    await attempts.upsertEntity({ ...receipt, state: sent.simulated ? "simulated" : "sent" }, "Merge");
    return !sent.simulated;
  } catch {
    context.log.warn("Payment was recorded but receipt delivery needs review.");
    await attempts.upsertEntity({ ...receipt, state: "needs-review" }, "Merge").catch(() => {});
    return false;
  }
}

function paymentResult(payment, receiptSent) {
  return {
    ok: true,
    provider: payment.paymentProvider,
    mode: payment.mode,
    invoiceId: payment.invoiceId,
    invoiceNumber: payment.invoiceNumber,
    amount: Number(payment.paymentAmount).toFixed(2),
    paidAmount: payment.paidAmount,
    receiptSent,
    transactionId: payment.paymentTransactionId,
    accountNumber: payment.paymentAccountNumber
  };
}
