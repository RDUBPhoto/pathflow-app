module.exports = async function (context, req) {
  context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, message: "pong" } };
};
