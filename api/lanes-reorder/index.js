const { requirePrincipal } = require("../_shared/auth");

module.exports = async function (context, req) {
  const m = (req.method || "GET").toUpperCase();
  if (m === "OPTIONS") { context.res = { status: 204 }; return; }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    context.res = {
      status: 400,
      headers: { "content-type": "application/json" },
      body: { error: "Workflow lanes are locked and cannot be reordered." }
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
