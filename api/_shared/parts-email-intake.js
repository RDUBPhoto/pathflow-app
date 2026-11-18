const { randomUUID } = require("crypto");

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return [];
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeToken(value) {
  return asString(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function compactToken(value) {
  return asString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stripHtml(value) {
  return asString(value)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function extractEmails(value) {
  const raw = asString(value);
  if (!raw) return [];
  const matches = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return uniqueStrings(matches.map(item => item.toLowerCase()));
}

function parseEnvelopeRecipients(value) {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return parseEnvelopeRecipients(JSON.parse(value));
    } catch (_) {
      return extractEmails(value);
    }
  }
  if (Array.isArray(value)) return uniqueStrings(value.flatMap(item => parseEnvelopeRecipients(item)));
  if (typeof value === "object") {
    return uniqueStrings([
      ...parseEnvelopeRecipients(value.to),
      ...parseEnvelopeRecipients(value.cc),
      ...parseEnvelopeRecipients(value.bcc),
      ...extractEmails(value.email),
      ...extractEmails(value.address)
    ]);
  }
  return [];
}

function firstText(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function normalizeInboundEmailPayload(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const provider = asString(
    source.provider ||
    source.mailProvider ||
    source["X-Mail-Provider"] ||
    source["x-mail-provider"]
  ).toLowerCase() || "generic";
  const envelopeRecipients = parseEnvelopeRecipients(source.envelope);
  const recipients = uniqueStrings([
    ...extractEmails(source.to),
    ...extractEmails(source.To),
    ...extractEmails(source.recipient),
    ...extractEmails(source.Recipient),
    ...extractEmails(source.recipients),
    ...extractEmails(source["delivered-to"]),
    ...extractEmails(source["Delivered-To"]),
    ...extractEmails(source["X-Original-To"]),
    ...extractEmails(source["x-original-to"]),
    ...envelopeRecipients
  ]);
  const cc = uniqueStrings([...extractEmails(source.cc), ...extractEmails(source.Cc)]);
  const from = firstText(
    source.from,
    source.From,
    source.sender,
    source.Sender,
    source["reply-to"],
    source["Reply-To"]
  );
  const subject = firstText(source.subject, source.Subject, source["stripped-subject"]);
  const message = firstText(
    source.message,
    source.text,
    source.body,
    source.TextBody,
    source["body-plain"],
    source["stripped-text"],
    source.plain
  );
  const html = firstText(
    source.html,
    source.HtmlBody,
    source["body-html"],
    source["stripped-html"]
  );
  return {
    provider,
    messageId: firstText(source.messageId, source.MessageID, source["Message-Id"], source["message-id"]),
    from,
    to: recipients.join(", "),
    cc: cc.join(", "),
    subject,
    message,
    html,
    raw: source
  };
}

function normalizeCarrier(value) {
  const raw = asString(value).toLowerCase();
  if (!raw) return "";
  if (raw.includes("ups")) return "UPS";
  if (raw.includes("fedex") || raw.includes("federal express")) return "FedEx";
  if (raw.includes("usps") || raw.includes("postal")) return "USPS";
  if (raw.includes("dhl")) return "DHL";
  if (raw.includes("ontrac")) return "OnTrac";
  if (raw.includes("lasership")) return "LaserShip";
  return asString(value);
}

function detectCarrier(text, trackingNumber) {
  const source = `${text}\n${trackingNumber}`;
  const labeled = source.match(/\b(?:carrier|ship(?:ped)?\s+via|via)\s*[:#-]?\s*(ups|fedex|federal express|usps|postal service|dhl|ontrac|lasership)\b/i);
  if (labeled) return normalizeCarrier(labeled[1]);
  if (/\bUPS\b/i.test(source) || /^1Z/i.test(asString(trackingNumber))) return "UPS";
  if (/\bFedEx\b/i.test(source)) return "FedEx";
  if (/\bUSPS\b/i.test(source) || /^(9\d{21,25}|[A-Z]{2}\d{9}US)$/i.test(asString(trackingNumber))) return "USPS";
  if (/\bDHL\b/i.test(source)) return "DHL";
  return "";
}

function labeledValue(text, labels, pattern = "[A-Z0-9][A-Z0-9._-]{2,}") {
  const escaped = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`\\b(?:${escaped})[ \\t]*(?:number|no\\.?|#)?[ \\t]*[:#-]?[ \\t]*(${pattern})`, "i");
  const match = asString(text).match(re);
  return asString(match && match[1]).replace(/[).,;:]+$/g, "");
}

function extractTrackingNumber(text) {
  const labeled = labeledValue(text, ["tracking", "tracking number", "tracking no", "tracking #", "shipment tracking"], "[A-Z0-9][A-Z0-9 -]{6,35}");
  if (labeled) return labeled.replace(/\s+/g, "");

  const candidates = [
    /\b1Z[0-9A-Z]{16}\b/i,
    /\b9\d{21,25}\b/,
    /\b[A-Z]{2}\d{9}US\b/i,
    /\b(?:\d{12}|\d{15}|\d{20}|\d{22})\b/,
    /\bEZ\d{10}\b/i
  ];
  for (const re of candidates) {
    const match = asString(text).match(re);
    if (match) return asString(match[0]).replace(/\s+/g, "");
  }
  return "";
}

function extractOrderNumber(text) {
  const poNumber = labeledValue(text, [
    "purchase order",
    "po",
    "po number",
    "po #"
  ], "[A-Z0-9][A-Z0-9._-]{2,}");
  if (poNumber) return poNumber;

  return labeledValue(text, [
    "order number",
    "order",
    "order #",
    "confirmation",
    "confirmation number"
  ], "[A-Z0-9][A-Z0-9._-]{2,}");
}

function extractVendorInvoiceNumber(text) {
  return labeledValue(text, [
    "vendor invoice",
    "invoice",
    "invoice number",
    "invoice #",
    "receipt",
    "receipt number"
  ], "[A-Z0-9][A-Z0-9._-]{2,}");
}

function dateOnlyFromText(value) {
  const raw = asString(value).replace(/^(by|on|around)\s+/i, "").trim();
  if (!raw) return "";
  const currentYear = new Date().getFullYear();
  const normalized = /^\d{1,2}\/\d{1,2}$/.test(raw)
    ? `${raw}/${currentYear}`
    : raw;
  const ts = Date.parse(normalized);
  if (!Number.isFinite(ts)) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

function extractEtaDate(text) {
  const source = asString(text);
  const labeled = source.match(/\b(?:eta|estimated delivery|expected delivery|delivery date|arriv(?:es|ing)|delivers?)\s*[:#-]?\s*((?:by|on|around)?\s*(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|[A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?))/i);
  if (labeled) return dateOnlyFromText(labeled[1]);

  const plain = source.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  return plain ? dateOnlyFromText(plain[1]) : "";
}

function extractPartHints(text) {
  const source = asString(text);
  const sku = labeledValue(source, ["sku", "part number", "part #", "item", "item number"], "[A-Z0-9][A-Z0-9._-]{2,}");
  const partNameMatch = source.match(/\b(?:part|item|product)\s*(?:name|description)?\s*[:#-]\s*([^\n\r]{3,120})/i);
  return {
    sku,
    partName: asString(partNameMatch && partNameMatch[1]).replace(/[).,;:]+$/g, "")
  };
}

function parseVendorEmail(input = {}) {
  const subject = asString(input.subject);
  const plain = asString(input.message || input.text || input.body);
  const html = stripHtml(input.html);
  const source = [subject, plain, html].filter(Boolean).join("\n");
  const trackingNumber = extractTrackingNumber(source);
  const carrier = normalizeCarrier(input.carrier) || detectCarrier(source, trackingNumber);
  const partHints = extractPartHints(source);
  return {
    from: asString(input.from),
    to: asString(input.to),
    subject,
    message: plain || html,
    orderNumber: asString(input.orderNumber) || extractOrderNumber(source),
    trackingNumber: asString(input.trackingNumber) || trackingNumber,
    carrier,
    etaDate: asString(input.etaDate) || extractEtaDate(source),
    vendorInvoiceNumber: asString(input.vendorInvoiceNumber) || extractVendorInvoiceNumber(source),
    sku: asString(input.sku) || partHints.sku,
    partName: asString(input.partName) || partHints.partName,
    purchaseOrderId: asString(input.purchaseOrderId || input.poId || input.id),
    lineId: asString(input.lineId),
    sourceText: source
  };
}

function parseLines(value) {
  return asArray(value).map((line, index) => {
    const source = line && typeof line === "object" ? line : {};
    const qty = Math.max(1, Math.floor(asNumber(source.qty, 1)));
    const qtyReceived = Math.max(0, Math.min(qty, asNumber(source.qtyReceived, 0)));
    const unitCost = Math.max(0, asNumber(source.unitCost, 0));
    return {
      lineId: asString(source.lineId) || `line-${index + 1}`,
      needId: asString(source.needId),
      itemId: asString(source.itemId || source.relatedInventoryItemId),
      relatedInventoryItemId: asString(source.relatedInventoryItemId || source.itemId),
      relatedInvoiceId: asString(source.relatedInvoiceId),
      relatedInvoiceLineItemId: asString(source.relatedInvoiceLineItemId),
      jobId: asString(source.jobId),
      jobNumber: asString(source.jobNumber),
      partName: asString(source.partName || source.name || source.description),
      sku: asString(source.sku || source.partNumber),
      vendorId: asString(source.vendorId),
      vendor: asString(source.vendor || source.vendorHint || source.supplier),
      qty,
      qtyNeeded: Math.max(1, Math.floor(asNumber(source.qtyNeeded, qty))),
      qtyOrdered: Math.max(0, Math.floor(asNumber(source.qtyOrdered, qty))),
      qtyReceived,
      unitCost,
      orderNumber: asString(source.orderNumber),
      trackingNumber: asString(source.trackingNumber),
      etaDate: asString(source.etaDate),
      carrier: asString(source.carrier),
      trackingStatus: asString(source.trackingStatus),
      trackingStatusUpdatedAt: asString(source.trackingStatusUpdatedAt),
      estimatedDeliveryDate: asString(source.estimatedDeliveryDate),
      deliveredAt: asString(source.deliveredAt),
      trackingProvider: asString(source.trackingProvider),
      trackingProviderId: asString(source.trackingProviderId),
      trackingLastError: asString(source.trackingLastError),
      vendorInvoiceNumber: asString(source.vendorInvoiceNumber),
      note: asString(source.note || source.notes),
      lineTotal: Number((qty * unitCost).toFixed(2)),
      status: asString(source.status) || (qtyReceived >= qty ? "received" : (qtyReceived > 0 ? "partial" : "draft"))
    };
  }).filter(line => line.partName || line.sku);
}

function toPurchaseOrder(entity) {
  const lines = parseLines(entity && entity.linesJson);
  const subtotal = Number(lines.reduce((sum, item) => sum + asNumber(item.lineTotal, 0), 0).toFixed(2));
  return {
    id: asString(entity && entity.rowKey),
    supplier: asString(entity && entity.supplier),
    vendorId: asString(entity && entity.vendorId),
    status: asString(entity && entity.status).toLowerCase() || "draft",
    currency: asString(entity && entity.currency) || "USD",
    note: asString(entity && entity.note),
    lines,
    lineCount: lines.length,
    subtotal,
    createdAt: asString(entity && entity.createdAt),
    updatedAt: asString(entity && entity.updatedAt),
    submittedAt: asString(entity && entity.submittedAt) || null,
    receivedAt: asString(entity && entity.receivedAt) || null
  };
}

function lineScore(order, line, parsed, sourceText) {
  let score = 0;
  const text = normalizeToken(sourceText);
  const compactText = compactToken(sourceText);
  const orderNumber = compactToken(parsed.orderNumber);
  const trackingNumber = compactToken(parsed.trackingNumber);
  const parsedSku = compactToken(parsed.sku);
  const lineOrder = compactToken(line.orderNumber);
  const lineSku = compactToken(line.sku);
  const supplier = normalizeToken(order.supplier || line.vendor);
  const partName = normalizeToken(line.partName);

  if (parsed.purchaseOrderId && parsed.purchaseOrderId === order.id) score += 80;
  if (parsed.lineId && parsed.lineId === line.lineId) score += 100;
  if (orderNumber && lineOrder && orderNumber === lineOrder) score += 70;
  if (orderNumber && compactText.includes(compactToken(order.id))) score += 40;
  if (parsedSku && lineSku && parsedSku === lineSku) score += 45;
  if (lineSku && compactText.includes(lineSku)) score += 35;
  if (partName && text.includes(partName)) score += 25;
  if (supplier && text.includes(supplier)) score += 15;
  if (supplier && normalizeToken(parsed.from).includes(supplier)) score += 12;
  if (trackingNumber && !compactToken(line.trackingNumber)) score += 4;
  if (order.status === "ordered" || order.status === "draft") score += 3;

  return score;
}

function findBestLineMatch(orders, parsed) {
  const activeOrders = orders.filter(order => ["draft", "ordered", "received"].includes(asString(order.status).toLowerCase()));
  const candidates = [];
  for (const order of activeOrders) {
    if (parsed.purchaseOrderId && order.id !== parsed.purchaseOrderId) continue;
    for (const line of order.lines) {
      if (parsed.lineId && line.lineId !== parsed.lineId) continue;
      const score = lineScore(order, line, parsed, parsed.sourceText);
      candidates.push({ order, line, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  if (!best) return { matched: false, reason: "No active purchase order lines found.", candidates: [] };
  const threshold = parsed.purchaseOrderId || parsed.lineId ? 1 : 30;
  if (best.score < threshold) {
    return {
      matched: false,
      reason: "Could not confidently match vendor email to a purchase order line.",
      candidates: candidates.slice(0, 5).map(item => ({ orderId: item.order.id, lineId: item.line.lineId, score: item.score }))
    };
  }
  return {
    matched: true,
    order: best.order,
    line: best.line,
    score: best.score,
    candidates: candidates.slice(0, 5).map(item => ({ orderId: item.order.id, lineId: item.line.lineId, score: item.score }))
  };
}

function mergeNote(existing, parsed) {
  const pieces = [];
  if (parsed.subject) pieces.push(`Vendor email: ${parsed.subject}`);
  if (parsed.from) pieces.push(`From: ${parsed.from}`);
  const next = pieces.join(" | ");
  const current = asString(existing);
  if (!next || current.includes(next)) return current;
  return current ? `${current}\n${next}` : next;
}

function applyParsedEmailToOrder(order, lineId, parsed, now = new Date().toISOString()) {
  let updated = false;
  const lines = order.lines.map(line => {
    if (asString(line.lineId) !== asString(lineId)) return line;
    const nextTracking = asString(parsed.trackingNumber || line.trackingNumber);
    const nextCarrier = asString(parsed.carrier || line.carrier);
    const nextEta = asString(parsed.etaDate || line.etaDate);
    const nextInvoice = asString(parsed.vendorInvoiceNumber || line.vendorInvoiceNumber);
    const nextOrder = asString(parsed.orderNumber || line.orderNumber);
    const next = {
      ...line,
      orderNumber: nextOrder,
      trackingNumber: nextTracking,
      carrier: nextCarrier,
      etaDate: nextEta,
      estimatedDeliveryDate: nextEta || asString(line.estimatedDeliveryDate),
      vendorInvoiceNumber: nextInvoice,
      trackingStatus: nextTracking ? (asString(line.trackingStatus) || "tracking received") : asString(line.trackingStatus),
      trackingStatusUpdatedAt: nextTracking ? now : asString(line.trackingStatusUpdatedAt),
      trackingProvider: nextTracking ? (asString(line.trackingProvider) || "email") : asString(line.trackingProvider),
      trackingProviderId: nextTracking ? (asString(line.trackingProviderId) || `email-${randomUUID()}`) : asString(line.trackingProviderId),
      trackingLastError: "",
      note: mergeNote(line.note, parsed)
    };
    updated = true;
    return next;
  });
  return { updated, lines };
}

module.exports = {
  parseVendorEmail,
  findBestLineMatch,
  applyParsedEmailToOrder,
  toPurchaseOrder,
  parseLines,
  stripHtml,
  normalizeCarrier,
  normalizeInboundEmailPayload,
  extractEmails
};
