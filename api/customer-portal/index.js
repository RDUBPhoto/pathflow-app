const { managePortal, openPortal, publicSummary, portalTokenFromHeader, table } = require("../_shared/customer-portal");
const { resolveStaff } = require("../_shared/staff-access");
const { resolveTenantId } = require("../_shared/tenant");

function response(status, body) {
  return { status, headers: {
    "content-type": "application/json",
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow"
  }, body };
}

module.exports = async function (context, req) {
  const tenant = resolveTenantId(req, req.body);
  try {
    if (req.method === "GET") {
      const token = portalTokenFromHeader(req.headers);
      const visit = await openPortal(tenant, token);
      if (!visit) {
        context.res = response(404, { error: "This visit link is unavailable. Contact the shop for access." });
      } else if (visit.status === "expired") {
        context.res = response(410, { error: "This visit link has expired. Contact the shop for a new copy of your paperwork." });
      } else {
        context.res = response(200, await publicSummary(tenant, visit));
      }
      return;
    }
    const { actor, authorized } = await resolveStaff(req, await table("useraccess"), tenant);
    if (!authorized) {
      context.res = response(actor ? 403 : 401, { error: "Authorized staff session required." });
      return;
    }
    const { documentId, workItemId, action } = req.body || {};
    const canResolveAppointment = action === "issue" && /^[A-Za-z0-9._:-]{1,128}$/.test(workItemId || "");
    if ((typeof documentId !== "string" && !canResolveAppointment) || !["issue", "revoke", "rotate"].includes(action)) {
      context.res = response(400, { error: "Provide a quote or invoice and a valid portal action." });
      return;
    }
    let id = documentId;
    if (!id && canResolveAppointment) {
      try {
        const job = await (await table("workitems")).getEntity(tenant, workItemId);
        if (job.jobId) id = job.invoiceId;
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }
    const result = id ? await managePortal(tenant, id, action) : null;
    context.res = result ? response(200, result) : response(404, { error: "Save this document and link a customer before sharing the visit." });
  } catch {
    context.log?.error?.("Customer portal request failed.");
    context.res = response(503, { error: "The customer portal is temporarily unavailable. Please try again." });
  }
};
