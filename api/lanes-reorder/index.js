module.exports = async function (context, req) {
  const m = (req.method || "GET").toUpperCase();
  if (m === "OPTIONS") { context.res = { status: 204 }; return; }

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
