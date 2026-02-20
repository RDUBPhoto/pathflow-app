const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");
const { sanitizeTenantId } = require("../_shared/tenant");

const USERS_TABLE = "useraccess";
const TENANTS_TABLE = "tenants";
const EMAIL_VERIFICATIONS_TABLE = "emailverifications";
const USERS_PARTITION = "v1";
const TENANTS_PARTITION = "v1";
const EMAIL_VERIFICATIONS_PARTITION = "v1";
const VERIFY_TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  const lowered = asString(value).toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
}

function parseJson(value, fallback) {
  const raw = asString(value);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readHeader(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[key];
  if (direct != null) return asString(direct);
  const normalized = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name || "").toLowerCase() !== normalized) continue;
    return asString(value);
  }
  return "";
}

function readQueryParam(req, key) {
  if (req && req.query && req.query[key] != null) return asString(req.query[key]);
  const rawUrl = asString(req && req.url);
  if (!rawUrl || !rawUrl.includes("?")) return "";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function normalizeEmail(value) {
  return asString(value).toLowerCase();
}

function normalizeRole(value) {
  return asString(value).toLowerCase();
}

function normalizeRoleList(values) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeRole(value);
    if (!normalized) continue;
    out.add(normalized);
  }
  if (!out.has("authenticated")) out.add("authenticated");
  return Array.from(out);
}

function humanizeTenantId(tenantId) {
  const value = asString(tenantId).replace(/[-_]+/g, " ").trim();
  if (!value) return "Location";
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function digitsOnly(value) {
  return asString(value).replace(/\D+/g, "");
}

function isAllNines(value) {
  const digits = digitsOnly(value);
  return !!digits && /^9+$/.test(digits);
}

function normalizeBillingPayload(rawBilling) {
  const billing = asObject(rawBilling);
  const cardholderName = asString(billing.cardholderName || billing.name);
  const cardNumber = digitsOnly(billing.cardNumber || billing.number);
  const expiryMonthRaw = digitsOnly(billing.expiryMonth || billing.expMonth || billing.month);
  const expiryYearRaw = digitsOnly(billing.expiryYear || billing.expYear || billing.year);
  const cvc = digitsOnly(billing.cvc || billing.cvv || billing.securityCode);
  const postalCode = digitsOnly(billing.postalCode || billing.zip || billing.zipCode);

  if (!cardNumber) {
    return { ok: false, error: "Billing card number is required." };
  }

  if (isAllNines(cardNumber) && cardNumber.length >= 5) {
    return {
      ok: true,
      mode: "sandbox",
      last4: "9999"
    };
  }

  if (cardholderName.length < 2) {
    return { ok: false, error: "Cardholder name is required." };
  }
  if (cardNumber.length < 13 || cardNumber.length > 19) {
    return { ok: false, error: "Card number must be between 13 and 19 digits." };
  }
  if (expiryMonthRaw.length < 1 || expiryMonthRaw.length > 2) {
    return { ok: false, error: "Expiry month is required." };
  }
  if (expiryYearRaw.length < 2 || expiryYearRaw.length > 4) {
    return { ok: false, error: "Expiry year is required." };
  }
  if (cvc.length < 3 || cvc.length > 4) {
    return { ok: false, error: "CVC must be 3 or 4 digits." };
  }
  if (postalCode.length < 5) {
    return { ok: false, error: "Postal code must be at least 5 digits." };
  }

  const month = Number(expiryMonthRaw);
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    return { ok: false, error: "Expiry month must be between 1 and 12." };
  }

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const parsedYear = expiryYearRaw.length === 2 ? Number(`20${expiryYearRaw}`) : Number(expiryYearRaw);
  if (!Number.isFinite(parsedYear) || parsedYear < currentYear || parsedYear > currentYear + 25) {
    return { ok: false, error: "Expiry year is invalid." };
  }
  if (parsedYear === currentYear && month < currentMonth) {
    return { ok: false, error: "Card is expired." };
  }

  return {
    ok: true,
    mode: "pending",
    last4: cardNumber.slice(-4)
  };
}

function getEmailMode() {
  const mode = asString(process.env.EMAIL_MODE).toLowerCase();
  if (mode === "sendgrid") return "sendgrid";
  return "mock";
}

async function sendViaSendgrid(to, subject, text, html) {
  const key = asString(process.env.SENDGRID_API_KEY);
  const from = asString(process.env.EMAIL_FROM || process.env.FROM_EMAIL);
  if (!key || !from) {
    throw new Error("EMAIL_MODE is sendgrid but SENDGRID_API_KEY or EMAIL_FROM is missing.");
  }

  const content = [{ type: "text/plain", value: asString(text) }];
  if (asString(html)) {
    content.push({ type: "text/html", value: asString(html) });
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject: asString(subject),
      content
    })
  });

  if (!response.ok) {
    const detail = asString(await response.text());
    throw new Error(`SendGrid rejected message (${response.status}): ${detail || "Unknown provider error."}`);
  }
}

async function sendTransactionalEmail(context, payload) {
  const to = normalizeEmail(payload && payload.to);
  if (!to) return false;
  const subject = asString(payload && payload.subject);
  const text = asString(payload && payload.text);
  const html = asString(payload && payload.html);

  const mode = getEmailMode();
  if (mode === "sendgrid") {
    try {
      await sendViaSendgrid(to, subject, text, html);
      return true;
    } catch (err) {
      context.log.warn(`[access] transactional email failed: ${String((err && err.message) || err)}`);
      return false;
    }
  }

  context.log(`[access] mock email -> ${to} | ${subject}`);
  return true;
}

function buildVerifyBaseUrl(req) {
  const explicit = asString(process.env.APP_BASE_URL || process.env.PUBLIC_APP_BASE_URL);
  if (explicit) return explicit.replace(/\/+$/, "");

  const proto = asString(readHeader(req && req.headers, "x-forwarded-proto")) || "https";
  const host = asString(readHeader(req && req.headers, "x-forwarded-host")) ||
    asString(readHeader(req && req.headers, "host")) ||
    asString(process.env.WEBSITE_HOSTNAME);
  if (!host) return "http://localhost:4200";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function html(status, markup) {
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    },
    body: markup
  };
}

function renderVerifyPage(title, body, status = "ok") {
  const palette = status === "ok" ? "#1fb66f" : status === "warn" ? "#d97706" : "#d14343";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0f1728; color: #e5e7eb; display: grid; min-height: 100vh; place-items: center; }
    .card { width: min(560px, calc(100vw - 32px)); background: #1d2738; border: 1px solid #334155; border-radius: 16px; padding: 24px; box-shadow: 0 12px 30px rgba(0,0,0,.35); }
    .status { color: ${palette}; font-weight: 700; letter-spacing: .02em; font-size: 12px; text-transform: uppercase; margin: 0 0 8px; }
    h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.15; }
    p { margin: 0; color: #cbd5e1; line-height: 1.6; }
  </style>
</head>
<body>
  <main class="card">
    <p class="status">${status === "ok" ? "Verified" : status === "warn" ? "Already Verified" : "Verification Error"}</p>
    <h1>${title}</h1>
    <p>${body}</p>
  </main>
</body>
</html>`;
}

function parsePrincipal(req) {
  const encoded = readHeader(req && req.headers, "x-ms-client-principal");
  if (!encoded) return null;

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const raw = parseJson(decoded, {});
    const claims = Array.isArray(raw.claims) ? raw.claims : [];

    const claimEmail = claims.find(item => asString(item && item.typ).toLowerCase() === "emails")?.val ||
      claims.find(item => asString(item && item.typ).toLowerCase() === "email")?.val ||
      claims.find(item => asString(item && item.typ).toLowerCase() === "preferred_username")?.val;

    const userDetails = asString(raw.userDetails);
    const email = normalizeEmail(claimEmail || (userDetails.includes("@") ? userDetails : ""));
    if (!email) return null;

    return {
      userId: asString(raw.userId || email),
      email,
      displayName: userDetails || email,
      identityProvider: asString(raw.identityProvider || "unknown"),
      userRoles: normalizeRoleList(raw.userRoles || [])
    };
  } catch {
    return null;
  }
}

async function getTableClient(connectionString, tableName) {
  const client = TableClient.fromConnectionString(connectionString, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function listTenants(tenantClient) {
  const out = [];
  const filter = `PartitionKey eq '${escapedFilterValue(TENANTS_PARTITION)}'`;
  const iter = tenantClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
    const id = sanitizeTenantId(asString(entity.rowKey));
    if (!id) continue;
    const name = asString(entity.name) || humanizeTenantId(id);
    out.push({ id, name });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  return out;
}

async function getUserEntity(userClient, email) {
  const rowKey = normalizeEmail(email);
  if (!rowKey) return null;
  try {
    return await userClient.getEntity(USERS_PARTITION, rowKey);
  } catch {
    return null;
  }
}

async function anyUsersExist(userClient) {
  const filter = `PartitionKey eq '${escapedFilterValue(USERS_PARTITION)}'`;
  const iter = userClient.listEntities({ queryOptions: { filter } });
  for await (const _entity of iter) {
    return true;
  }
  return false;
}

function parseUserLocationIds(userEntity) {
  const parsed = parseJson(userEntity && userEntity.locationIdsJson, []);
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(parsed) ? parsed : []) {
    const id = sanitizeTenantId(asString(value));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseUserRoles(userEntity) {
  const parsed = parseJson(userEntity && userEntity.rolesJson, []);
  return normalizeRoleList(Array.isArray(parsed) ? parsed : []);
}

function buildUserLocations(userEntity, tenants) {
  const tenantList = Array.isArray(tenants) ? tenants : [];
  const allLocations = asBool(userEntity && userEntity.allLocations);
  const allowedIds = parseUserLocationIds(userEntity);

  if (allLocations || !allowedIds.length) {
    return [...tenantList];
  }

  const byId = new Map(tenantList.map(item => [item.id, item]));
  return allowedIds.map(id => byId.get(id) || { id, name: humanizeTenantId(id) });
}

function pickDefaultLocation(userEntity, locations) {
  const normalized = sanitizeTenantId(asString(userEntity && userEntity.defaultLocationId));
  if (normalized && locations.some(item => item.id === normalized)) return normalized;
  return locations[0]?.id || "";
}

function buildMeResponse(principal, userEntity, allTenants, canBootstrap) {
  if (!userEntity) {
    return {
      ok: true,
      canBootstrap: !!canBootstrap,
      profile: null,
      locations: allTenants,
      principal: {
        userId: asString(principal && principal.userId),
        email: asString(principal && principal.email),
        displayName: asString(principal && principal.displayName),
        identityProvider: asString(principal && principal.identityProvider)
      }
    };
  }

  const roles = parseUserRoles(userEntity);
  const locations = buildUserLocations(userEntity, allTenants);
  const defaultLocationId = pickDefaultLocation(userEntity, locations);

  return {
    ok: true,
    canBootstrap: !!canBootstrap,
    profile: {
      email: normalizeEmail(userEntity.email || principal.email),
      displayName: asString(userEntity.displayName || principal.displayName || principal.email),
      isSuperAdmin: asBool(userEntity.isSuperAdmin),
      roles,
      defaultLocationId,
      locations,
      emailVerified: asBool(userEntity.emailVerified) || !!asString(userEntity.emailVerifiedAt)
    },
    locations: allTenants,
    principal: {
      userId: asString(principal && principal.userId),
      email: asString(principal && principal.email),
      displayName: asString(principal && principal.displayName),
      identityProvider: asString(principal && principal.identityProvider)
    }
  };
}

function json(status, body) {
  return {
    status,
    headers: {
      "content-type": "application/json"
    },
    body
  };
}

async function issueEmailVerificationToken(tokenClient, payload) {
  const token = randomUUID().replace(/-/g, "");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + VERIFY_TOKEN_MAX_AGE_MS);
  await tokenClient.upsertEntity(
    {
      partitionKey: EMAIL_VERIFICATIONS_PARTITION,
      rowKey: token,
      email: normalizeEmail(payload.email),
      userId: asString(payload.userId),
      locationId: sanitizeTenantId(asString(payload.locationId)),
      locationName: asString(payload.locationName),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      consumedAt: ""
    },
    "Merge"
  );
  return token;
}

async function sendVerificationEmail(context, payload) {
  const display = asString(payload.displayName || payload.email);
  const firstName = display.split(/\s+/).filter(Boolean)[0] || "there";
  const subject = `Verify your Pathflow email for ${asString(payload.locationName || "your workspace")}`;
  const text = [
    `Hi ${firstName},`,
    "",
    "Please verify your email address to activate your Pathflow account.",
    payload.verifyUrl,
    "",
    "If you did not request this setup, you can ignore this message."
  ].join("\n");
  const htmlMarkup = [
    `<p>Hi ${firstName},</p>`,
    `<p>Please verify your email address to activate your Pathflow account.</p>`,
    `<p><a href="${payload.verifyUrl}">Verify email</a></p>`,
    `<p>If you did not request this setup, you can ignore this message.</p>`
  ].join("");
  await sendTransactionalEmail(context, {
    to: payload.email,
    subject,
    text,
    html: htmlMarkup
  });
}

async function sendWelcomeEmail(context, payload) {
  const display = asString(payload.displayName || payload.email);
  const firstName = display.split(/\s+/).filter(Boolean)[0] || "there";
  const workspaceName = asString(payload.locationName || "your workspace");
  const subject = `Welcome to Pathflow - ${workspaceName}`;
  const text = [
    `Hi ${firstName},`,
    "",
    `Welcome to Pathflow. ${workspaceName} is ready to use.`,
    "",
    "You can now sign in and start managing leads, scheduling, and communication."
  ].join("\n");
  const htmlMarkup = [
    `<p>Hi ${firstName},</p>`,
    `<p>Welcome to Pathflow. <strong>${workspaceName}</strong> is ready to use.</p>`,
    `<p>You can now sign in and start managing leads, scheduling, and communication.</p>`
  ].join("");
  await sendTransactionalEmail(context, {
    to: payload.email,
    subject,
    text,
    html: htmlMarkup
  });
}

async function handleVerifyEmailRequest(context, req, clients) {
  const token = asString(readQueryParam(req, "token"));
  if (!token) {
    context.res = html(400, renderVerifyPage("Missing token", "This verification link is missing a token.", "error"));
    return;
  }

  let tokenEntity = null;
  try {
    tokenEntity = await clients.tokenClient.getEntity(EMAIL_VERIFICATIONS_PARTITION, token);
  } catch {
    tokenEntity = null;
  }
  if (!tokenEntity) {
    context.res = html(400, renderVerifyPage("Invalid link", "The verification link is invalid or no longer available.", "error"));
    return;
  }

  const email = normalizeEmail(tokenEntity.email);
  if (!email) {
    context.res = html(400, renderVerifyPage("Invalid link", "The verification token is missing email details.", "error"));
    return;
  }

  const now = Date.now();
  const expiresAtMs = Date.parse(asString(tokenEntity.expiresAt));
  const createdAtMs = Date.parse(asString(tokenEntity.createdAt));
  const isExpired = Number.isFinite(expiresAtMs)
    ? now > expiresAtMs
    : Number.isFinite(createdAtMs)
      ? now - createdAtMs > VERIFY_TOKEN_MAX_AGE_MS
      : false;
  if (isExpired) {
    context.res = html(410, renderVerifyPage("Link expired", "This verification link has expired. Request a new verification email.", "error"));
    return;
  }

  const userEntity = await getUserEntity(clients.userClient, email);
  if (!userEntity) {
    context.res = html(404, renderVerifyPage("User not found", "The account associated with this link was not found.", "error"));
    return;
  }

  const consumedAt = asString(tokenEntity.consumedAt);
  const alreadyVerified = asBool(userEntity.emailVerified) || !!asString(userEntity.emailVerifiedAt);
  const nowIso = new Date().toISOString();

  if (!consumedAt) {
    await clients.tokenClient.upsertEntity(
      {
        partitionKey: EMAIL_VERIFICATIONS_PARTITION,
        rowKey: token,
        consumedAt: nowIso,
        updatedAt: nowIso
      },
      "Merge"
    );
  }

  if (!alreadyVerified) {
    await clients.userClient.upsertEntity(
      {
        partitionKey: USERS_PARTITION,
        rowKey: email,
        emailVerified: true,
        emailVerifiedAt: nowIso,
        updatedAt: nowIso
      },
      "Merge"
    );

    await sendWelcomeEmail(context, {
      email,
      displayName: asString(userEntity.displayName || email),
      locationName: asString(tokenEntity.locationName || humanizeTenantId(tokenEntity.locationId))
    });
  }

  if (alreadyVerified || consumedAt) {
    context.res = html(200, renderVerifyPage("Email already verified", "Your email was already verified. You can return to the app and continue.", "warn"));
    return;
  }

  context.res = html(200, renderVerifyPage("Email verified", "Thanks - your email has been verified. You can return to the app now.", "ok"));
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "GET";
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  try {
    const connectionString = asString(process.env.STORAGE_CONNECTION_STRING);
    if (!connectionString) {
      context.res = json(500, { ok: false, error: "Missing STORAGE_CONNECTION_STRING" });
      return;
    }

    const opFromQuery = asString(readQueryParam(req, "op")).toLowerCase();
    if (method === "GET" && opFromQuery === "verify-email") {
      const userClient = await getTableClient(connectionString, USERS_TABLE);
      const tokenClient = await getTableClient(connectionString, EMAIL_VERIFICATIONS_TABLE);
      await handleVerifyEmailRequest(context, req, { userClient, tokenClient });
      return;
    }

    const principal = parsePrincipal(req);
    if (!principal) {
      context.res = json(401, { ok: false, error: "Not authenticated." });
      return;
    }

    const userClient = await getTableClient(connectionString, USERS_TABLE);
    const tenantClient = await getTableClient(connectionString, TENANTS_TABLE);

    if (method === "GET") {
      const userEntity = await getUserEntity(userClient, principal.email);
      const usersExist = userEntity ? true : await anyUsersExist(userClient);
      const allTenants = await listTenants(tenantClient);
      const canBootstrap = !userEntity && !usersExist;

      context.res = json(200, buildMeResponse(principal, userEntity, allTenants, canBootstrap));
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { ok: false, error: "Method not allowed." });
      return;
    }

    const body = asObject(req && req.body);
    const op = asString(body.op).toLowerCase();
    if (op !== "bootstrap") {
      context.res = json(400, { ok: false, error: "Unsupported operation." });
      return;
    }

    let userEntity = await getUserEntity(userClient, principal.email);
    if (!userEntity) {
      const usersExist = await anyUsersExist(userClient);
      if (usersExist) {
        context.res = json(403, {
          ok: false,
          error: "Workspace already initialized. Ask an admin to grant access."
        });
        return;
      }

      const billing = normalizeBillingPayload(body.billing);
      if (!billing.ok) {
        context.res = json(400, { ok: false, error: billing.error || "Billing information is invalid." });
        return;
      }

      const locationName = asString(body.locationName || "Exodus 4x4").slice(0, 120) || "Exodus 4x4";
      const locationId = sanitizeTenantId(asString(body.locationId || locationName || "exodus-4x4"));
      if (!locationId) {
        context.res = json(400, { ok: false, error: "Invalid location id." });
        return;
      }

      const now = new Date().toISOString();
      await tenantClient.upsertEntity(
        {
          partitionKey: TENANTS_PARTITION,
          rowKey: locationId,
          name: locationName,
          status: "active",
          billingStatus: billing.mode,
          billingLast4: billing.last4,
          billingUpdatedAt: now,
          updatedAt: now,
          createdAt: now
        },
        "Merge"
      );

      const roles = normalizeRoleList(["authenticated", "admin"]);
      await userClient.upsertEntity(
        {
          partitionKey: USERS_PARTITION,
          rowKey: principal.email,
          userId: asString(principal.userId || principal.email),
          email: principal.email,
          displayName: asString(principal.displayName || principal.email),
          identityProvider: asString(principal.identityProvider || "unknown"),
          rolesJson: JSON.stringify(roles),
          isSuperAdmin: true,
          allLocations: true,
          defaultLocationId: locationId,
          locationIdsJson: JSON.stringify([locationId]),
          emailVerified: false,
          emailVerifiedAt: "",
          updatedAt: now,
          createdAt: now
        },
        "Merge"
      );

      userEntity = await getUserEntity(userClient, principal.email);

      const tokenClient = await getTableClient(connectionString, EMAIL_VERIFICATIONS_TABLE);
      const verifyToken = await issueEmailVerificationToken(tokenClient, {
        email: principal.email,
        userId: principal.userId,
        locationId,
        locationName
      });
      const verifyUrl = `${buildVerifyBaseUrl(req)}/api/access?op=verify-email&token=${encodeURIComponent(verifyToken)}`;
      await sendVerificationEmail(context, {
        email: principal.email,
        displayName: asString(principal.displayName || principal.email),
        locationName,
        verifyUrl
      });
    }

    const allTenants = await listTenants(tenantClient);
    context.res = json(200, buildMeResponse(principal, userEntity, allTenants, false));
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      ok: false,
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
