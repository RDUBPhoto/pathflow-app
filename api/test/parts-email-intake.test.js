const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseVendorEmail,
  findBestLineMatch,
  applyParsedEmailToOrder,
  normalizeInboundEmailPayload,
  extractEmails
} = require("../_shared/parts-email-intake");

test("parts vendor email parser extracts order, tracking, carrier, ETA, and invoice fields", () => {
  const parsed = parseVendorEmail({
    from: "orders@sdhqoffroad.com",
    subject: "SDHQ order ORD-4932 has shipped",
    message: [
      "Purchase Order: PO-12345",
      "SKU: SDHQ-RAPTOR-CV-C",
      "Tracking #: 1Z999AA10123456784",
      "Carrier: UPS",
      "ETA: 07/12/2026",
      "Vendor Invoice #: INV-9001"
    ].join("\n")
  });

  assert.equal(parsed.orderNumber, "PO-12345");
  assert.equal(parsed.trackingNumber, "1Z999AA10123456784");
  assert.equal(parsed.carrier, "UPS");
  assert.equal(parsed.etaDate, "2026-07-12");
  assert.equal(parsed.vendorInvoiceNumber, "INV-9001");
  assert.equal(parsed.sku, "SDHQ-RAPTOR-CV-C");
});

test("parts vendor email matcher updates an existing purchase order line", () => {
  const order = {
    id: "po-123",
    supplier: "SDHQ",
    status: "ordered",
    lines: [{
      lineId: "line-1",
      partName: "'10-14 Ford Raptor SDHQ Built CV Boot Kit",
      sku: "SDHQ-RAPTOR-CV-C",
      vendor: "SDHQ",
      qty: 1,
      qtyReceived: 0,
      unitCost: 125,
      lineTotal: 125,
      orderNumber: "",
      trackingNumber: "",
      etaDate: "",
      carrier: "",
      vendorInvoiceNumber: "",
      note: ""
    }]
  };

  const parsed = parseVendorEmail({
    from: "orders@sdhqoffroad.com",
    subject: "SDHQ shipment confirmation",
    message: "Order # ORD-4932\nSKU SDHQ-RAPTOR-CV-C\nTracking 1Z999AA10123456784\nExpected delivery 2026-07-12"
  });

  const match = findBestLineMatch([order], parsed);
  assert.equal(match.matched, true);
  assert.equal(match.line.lineId, "line-1");

  const applied = applyParsedEmailToOrder(order, match.line.lineId, parsed, "2026-07-07T12:00:00.000Z");
  assert.equal(applied.updated, true);
  assert.equal(applied.lines[0].orderNumber, "ORD-4932");
  assert.equal(applied.lines[0].trackingNumber, "1Z999AA10123456784");
  assert.equal(applied.lines[0].carrier, "UPS");
  assert.equal(applied.lines[0].etaDate, "2026-07-12");
  assert.equal(applied.lines[0].trackingStatus, "tracking received");
  assert.equal(applied.lines[0].trackingProvider, "email");
});

test("parts inbound email normalizer supports common provider payload shapes", () => {
  const sendGrid = normalizeInboundEmailPayload({
    provider: "sendgrid",
    from: "SDHQ Orders <orders@sdhqoffroad.com>",
    to: "orders+shop-a@pathflow-app.com",
    envelope: JSON.stringify({ to: ["parts@exodus4x4.com"] }),
    subject: "Order shipped",
    text: "Tracking #: 1Z999AA10123456784"
  });
  assert.equal(sendGrid.provider, "sendgrid");
  assert.equal(sendGrid.from, "SDHQ Orders <orders@sdhqoffroad.com>");
  assert.equal(sendGrid.subject, "Order shipped");
  assert.ok(extractEmails(sendGrid.to).includes("orders+shop-a@pathflow-app.com"));
  assert.ok(extractEmails(sendGrid.to).includes("parts@exodus4x4.com"));

  const mailgun = normalizeInboundEmailPayload({
    provider: "mailgun",
    sender: "shipments@vendor.test",
    recipient: "orders+shop-b@pathflow-app.com",
    Subject: "Confirmation",
    "body-plain": "Order # PO-42"
  });
  assert.equal(mailgun.from, "shipments@vendor.test");
  assert.equal(mailgun.to, "orders+shop-b@pathflow-app.com");
  assert.equal(mailgun.message, "Order # PO-42");

  const postmark = normalizeInboundEmailPayload({
    provider: "postmark",
    From: "vendor@example.test",
    To: "parts@example.test",
    Subject: "Invoice",
    TextBody: "Vendor Invoice #: INV-42",
    HtmlBody: "<p>Vendor Invoice #: INV-42</p>"
  });
  assert.equal(postmark.from, "vendor@example.test");
  assert.equal(postmark.to, "parts@example.test");
  assert.equal(postmark.html, "<p>Vendor Invoice #: INV-42</p>");
});
