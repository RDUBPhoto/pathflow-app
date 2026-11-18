const ENDPOINTS = {
  test: { apiBase: "https://api.sandbox.paylynxgateway.com/api/v2" },
  live: { apiBase: "https://api.paylynxgateway.com/api/v2" }
};

function gatewayConfig(tenantId, mode = "test") {
  if (!tenantId || !Object.hasOwn(ENDPOINTS, mode)) return null;
  let accounts;
  try { accounts = JSON.parse(process.env.PAYLYNX_ACCOUNTS_JSON || "{}"); } catch { return null; }
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return null;
  const credentials = Object.hasOwn(accounts, tenantId) ? accounts[tenantId]?.[mode] : null;
  if (credentials) return validatedConfig(credentials, mode);
  return mode === "test" ? sandboxConfig(tenantId) : null;
}

function validatedConfig(credentials, mode) {
  const sourceKey = String(credentials.sourceKey || "").trim();
  const tokenizationKey = String(credentials.tokenizationKey || "").trim();
  const pin = String(credentials.pin || "").trim();
  if (!sourceKey || sourceKey.startsWith("pk_") || sourceKey.includes(":") ||
      !/^pk_[A-Za-z0-9]+$/.test(tokenizationKey)) return null;
  return { sourceKey, pin, tokenizationKey, mode, ...ENDPOINTS[mode] };
}

function sandboxConfig(tenantId) {
  const env = process.env;
  if (env.WEBSITE_SITE_NAME || env.PATHFLOW_ENVIRONMENT !== "development" ||
      env.EMAIL_MODE !== "mock" || env.SMS_MODE !== "mock" ||
      !tenantId || tenantId !== env.PAYLYNX_SANDBOX_TENANT_ID?.trim()) return null;
  return validatedConfig({ sourceKey: env.PAYLYNX_SANDBOX_SOURCE_KEY,
    tokenizationKey: env.PAYLYNX_SANDBOX_TOKENIZATION_KEY, pin: env.PAYLYNX_SANDBOX_PIN }, "test");
}

async function gatewayRequest(config, path, payload) {
  const response = await fetch(`${config.apiBase}${path}`, {
    method: payload ? "POST" : "GET",
    headers: {
      authorization: `Basic ${Buffer.from(`${config.sourceKey}:${config.pin}`).toString("base64")}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "Pathflow PayLynx integration"
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(15_000),
    redirect: "error"
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

async function hasNoCardSurcharge(config) {
  const { ok, status, body } = await gatewayRequest(config, "/surcharge");
  if (status === 404) return true;
  if (!ok || !body || typeof body !== "object" || Array.isArray(body)) return false;
  return body.card == null || body.card.value === 0;
}

function rejectedPayment({ ok, status, body }) {
  const hasReference = Number.isSafeInteger(body?.reference_number) && body.reference_number > 0;
  if ([401, 403].includes(status)) return "permission";
  if (!(ok || status === 400) || body?.status_code === "A") return "";
  if (body?.status === "Declined" && body.status_code === "D") {
    if (body.cvv2_result_code === "N") return "security_code";
    return "declined";
  }
  if (!hasReference && body?.status === "Error" && body.status_code === "E" && status === 400) {
    const message = String(body.error_message || "");
    if (/permission|not (?:authorized|permitted)|disabled source/i.test(message)) return "permission";
    if (/\b(?:nonce|token)\b/i.test(message)) return "card_token";
    return "rejected";
  }
  return "";
}

async function chargeNonce(config, details) {
  const response = await gatewayRequest(config, "/transactions/charge", {
    source: details.source,
    amount: details.amount,
    name: details.cardholderName.slice(0, 255),
    expiry_month: Number(details.expiryMonth),
    expiry_year: Number(details.expiryYear),
    ...(details.billingZip ? { avs_zip: details.billingZip } : {}),
    capture: true,
    transaction_flags: { allow_partial_approval: false },
    transaction_details: { invoice_number: details.invoiceNumber.slice(0, 255), order_number: details.attemptKey }
  });
  const { ok, body } = response;
  const reason = rejectedPayment(response);
  if (reason) return { state: "declined", reason };
  if (!ok || body?.status !== "Approved" || body.status_code !== "A" ||
      !Number.isSafeInteger(body.reference_number) || body.reference_number <= 0 ||
      body.auth_amount !== details.amount) return { state: "pending" };
  return {
    state: "confirmed",
    transactionId: String(body.reference_number),
    accountNumber: /^\d{4}$/.test(body.last_4) ? body.last_4 : ""
  };
}

function invoiceCheckoutProvider(invoice, paymentSettings, tenantId) {
  const defaultProvider = paymentSettings?.defaultProvider ||
    paymentSettings?.providers?.find?.(item => item?.connected)?.key;
  if (defaultProvider === "paylynx") return "paylynx";
  return invoice.snapshotPaymentProvider || invoice.paymentProvider || "";
}

async function lookupCharge(config, referenceNumber) {
  const { ok, body } = await gatewayRequest(config, `/transactions/${referenceNumber}`);
  if (!ok || body?.id !== referenceNumber || body.transaction_details?.type !== "charge") return null;
  return { status: body.status_details?.status, amount: body.amount_details?.amount };
}

async function reverseCharge(config, operation, referenceNumber, amount) {
  const response = await gatewayRequest(config, `/transactions/${operation}`, {
    reference_number: referenceNumber,
    ...(operation === "refund" ? { amount } : {})
  });
  const { ok, body } = response;
  const reason = rejectedPayment(response);
  if (reason) return { state: reason === "permission" ? "unauthorized" : "declined" };
  if (!ok || body?.status !== "Approved" || body.status_code !== "A") return { state: "pending" };
  if (operation === "void") return { state: "confirmed", transactionId: `void-${referenceNumber}` };
  if (!Number.isSafeInteger(body.reference_number) || body.reference_number <= 0) return { state: "pending" };
  return { state: "confirmed", transactionId: String(body.reference_number) };
}

module.exports = { gatewayConfig, sandboxConfig, hasNoCardSurcharge, chargeNonce, invoiceCheckoutProvider, lookupCharge, reverseCharge };
