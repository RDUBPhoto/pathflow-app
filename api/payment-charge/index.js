const https = require("https");
const { TableClient } = require("@azure/data-tables");
const { resolveTenantId } = require("../_shared/tenant");

const SETTINGS_TABLE = "appsettings";
const PAYMENT_GATEWAY_SETTINGS_KEY = "billing.paymentProviders";
const AUTHORIZE_NET_CREDENTIALS_KEY = "billing.paymentProviders.authorizeNetCredentials";

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
    headers: { "content-type": "application/json" },
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
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, tableName);
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

function pickAuthorizeDebugDetail(responseBody, httpStatus) {
  const tx = asObject(responseBody && responseBody.transactionResponse);
  const messages = asObject(responseBody && responseBody.messages);
  const list = Array.isArray(messages.message) ? messages.message : [];
  const firstMsg = asObject(list[0]);
  const txErrors = Array.isArray(tx.errors) ? tx.errors : [];
  const firstErr = asObject(txErrors[0]);
  const parts = [
    `http=${Number(httpStatus || 0) || 0}`,
    `resultCode=${asString(messages.resultCode) || "-"}`,
    `msgCode=${asString(firstMsg.code) || "-"}`,
    `msgText=${asString(firstMsg.text || firstMsg.description) || "-"}`,
    `txResponseCode=${asString(tx.responseCode) || "-"}`,
    `txReasonCode=${asString(tx.responseReasonCode) || "-"}`,
    `txReason=${asString(tx.responseReasonDescription) || "-"}`,
    `txErrCode=${asString(firstErr.errorCode) || "-"}`,
    `txErrText=${asString(firstErr.errorText) || "-"}`,
    `raw=${asString(responseBody && responseBody.raw ? String(responseBody.raw).slice(0, 160) : "") || "-"}`
  ];
  return parts.join(" | ");
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "POST";
  const body = asObject(req && req.body);
  const tenantId = resolveTenantId(req, body);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  if (method !== "POST") {
    context.res = json(405, { ok: false, error: "Method not allowed." });
    return;
  }

  const invoiceId = asString(body.invoiceId || body.id);
  const invoiceNumber = asString(body.invoiceNumber || invoiceId || "");
  const amount = sanitizeAmount(body.amount);
  const cardNumber = onlyDigits(body.cardNumber);
  const cardCode = onlyDigits(body.cardCode);
  const expiryMonth = sanitizeMonth(body.expiryMonth);
  const expiryYear = sanitizeYear(body.expiryYear);
  const cardholderName = asString(body.cardholderName || body.customerName || "Customer");

  if (!invoiceId) {
    context.res = json(400, { ok: false, error: "invoiceId is required." });
    return;
  }
  if (!amount) {
    context.res = json(400, { ok: false, error: "Valid amount is required." });
    return;
  }
  if (cardNumber.length < 13 || cardNumber.length > 19) {
    context.res = json(400, { ok: false, error: "Valid card number is required." });
    return;
  }
  if (!expiryMonth || !expiryYear) {
    context.res = json(400, { ok: false, error: "Valid expiration month/year are required." });
    return;
  }
  if (cardCode.length < 3 || cardCode.length > 4) {
    context.res = json(400, { ok: false, error: "Valid card code is required." });
    return;
  }

  try {
    const settingsClient = await getTableClient(SETTINGS_TABLE);
    const paymentSettings = await getSettingValue(settingsClient, tenantId, PAYMENT_GATEWAY_SETTINGS_KEY);
    const authorizeProvider = resolveAuthorizeProvider(paymentSettings);
    if (!authorizeProvider.connected) {
      context.res = json(400, { ok: false, error: "Authorize.net is not connected for this workspace." });
      return;
    }

    const storedCredentials = await getSettingValue(settingsClient, tenantId, AUTHORIZE_NET_CREDENTIALS_KEY);
    const credentials = resolveCredentials(storedCredentials);
    if (!credentials.apiLoginId || !credentials.transactionKey) {
      context.res = json(400, { ok: false, error: "Authorize.net credentials are missing. Add API Login ID and Transaction Key in Admin > Payment Gateways." });
      return;
    }

    const endpoint = authorizeProvider.mode === "live"
      ? "https://api2.authorize.net/xml/v1/request.api"
      : "https://apitest.authorize.net/xml/v1/request.api";

    const name = splitCardholderName(cardholderName);
    const payload = {
      createTransactionRequest: {
        merchantAuthentication: {
          name: credentials.apiLoginId,
          transactionKey: credentials.transactionKey
        },
        refId: invoiceId,
        transactionRequest: {
          transactionType: "authCaptureTransaction",
          amount: amount.toFixed(2),
          payment: {
            creditCard: {
              cardNumber,
              expirationDate: `${expiryYear}-${expiryMonth}`,
              cardCode
            }
          },
          order: {
            invoiceNumber: invoiceNumber || invoiceId,
            description: `Pathflow invoice ${invoiceNumber || invoiceId}`
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
    const resultCode = asString(result?.messages?.resultCode).toLowerCase();
    const isOk = resultCode === "ok";
    const tx = asObject(result.transactionResponse);
    const approved = asString(tx.responseCode) === "1";
    const rawBody = asString(response && response.body && response.body.raw);
    const rawApproved =
      /<(?:[a-z0-9_]+:)?responseCode(?:\s[^>]*)?>\s*1\s*<\/(?:[a-z0-9_]+:)?responseCode>/i.test(rawBody)
      || /"responseCode"\s*:\s*"?1"?/i.test(rawBody)
      || /transaction has been approved/i.test(rawBody);
    const rawHasTransId =
      /<(?:[a-z0-9_]+:)?transId(?:\s[^>]*)?>\s*\d+\s*<\/(?:[a-z0-9_]+:)?transId>/i.test(rawBody);
    const rawHasJsonTransId = /"transId"\s*:\s*"?\d+"?/i.test(rawBody);
    const rawDeclined =
      /<(?:[a-z0-9_]+:)?responseCode(?:\s[^>]*)?>\s*[234]\s*<\/(?:[a-z0-9_]+:)?responseCode>/i.test(rawBody)
      || /"responseCode"\s*:\s*"?(?:2|3|4)"?/i.test(rawBody)
      || /transaction has been declined/i.test(rawBody);
    const txErrors = Array.isArray(tx.errors) ? tx.errors : [];
    const explicitDecline = (asString(tx.responseCode) && asString(tx.responseCode) !== "1")
      || txErrors.length > 0
      || rawDeclined;

    // In some sandbox/live edge responses, transactionResponse can be approved
    // while the top-level messages block is not strictly "Ok".
    const shouldTreatAsApproved =
      !explicitDecline && (
        approved
      || (isOk && !!asString(tx.transId))
      || (rawApproved && (rawHasTransId || rawHasJsonTransId || isOk))
      || (
        (rawHasTransId || rawHasJsonTransId)
        && response.status >= 200
        && response.status < 300
      )
      );

    if (!shouldTreatAsApproved) {
      const reason = pickAuthorizeError(result);
      const detail = pickAuthorizeDebugDetail(result, response.status);
      context.log.warn("Authorize.net declined", {
        tenantId,
        invoiceId,
        mode: authorizeProvider.mode,
        reason,
        detail
      });
      context.res = json(400, {
        ok: false,
        error: reason,
        detail,
        provider: "authorize-net"
      });
      return;
    }

    context.res = json(200, {
      ok: true,
      provider: "authorize-net",
      mode: authorizeProvider.mode,
      invoiceId,
      invoiceNumber,
      amount: amount.toFixed(2),
      transactionId: asString(tx.transId),
      authCode: asString(tx.authCode),
      avsResultCode: asString(tx.avsResultCode),
      accountType: asString(tx.accountType),
      accountNumber: asString(tx.accountNumber)
    });
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      ok: false,
      error: "Payment processing failed.",
      detail: asString(err && err.message)
    });
  }
};
