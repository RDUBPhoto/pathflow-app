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

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "POST";
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  // rolesSource is invoked internally by SWA after provider sign-in.
  // We keep custom roles empty and rely on app-level authorization.
  const body = asObject(req && req.body);
  const email = asString(body.userDetails);
  context.log("[getRoles] evaluated", { email: email || "unknown" });
  context.res = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { roles: [] }
  };
};
