function asString(value) {
  return value == null ? "" : String(value).trim();
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
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

function extractBody(req) {
  const rawBody = req && req.body;
  if (rawBody && typeof rawBody === "object") return rawBody;
  if (typeof rawBody === "string") return parseJson(rawBody, {});
  return {};
}

function decodeBase64Payload(value) {
  const raw = asString(value);
  if (!raw) return null;
  const marker = ";base64,";
  const idx = raw.indexOf(marker);
  const base64 = idx >= 0 ? raw.slice(idx + marker.length) : raw;
  const normalized = base64.replace(/\s+/g, "");
  if (!normalized) return null;
  try {
    return Buffer.from(normalized, "base64");
  } catch {
    return null;
  }
}

function normalizeVinChars(value) {
  return asString(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/I/g, "1")
    .replace(/[OQ]/g, "0");
}

function isVin(value) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(asString(value));
}

function collectVinCandidates(text) {
  const out = [];
  const seen = new Set();
  const pushCandidate = candidate => {
    const normalized = normalizeVinChars(candidate);
    if (!isVin(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  const full = normalizeVinChars(text);
  for (let i = 0; i <= full.length - 17; i += 1) {
    pushCandidate(full.slice(i, i + 17));
  }

  const chunks = asString(text).toUpperCase().match(/[A-Z0-9]{11,24}/g) || [];
  for (const chunk of chunks) {
    const compact = normalizeVinChars(chunk);
    for (let i = 0; i <= compact.length - 17; i += 1) {
      pushCandidate(compact.slice(i, i + 17));
    }
  }

  return out;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeEndpoint(value) {
  return asString(value).replace(/\/+$/, "");
}

async function startReadOperation(endpoint, apiKey, bytes) {
  const url = `${endpoint}/vision/v3.2/read/analyze?language=en&readingOrder=natural`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Content-Type": "application/octet-stream"
    },
    body: bytes
  });

  if (!response.ok) {
    const detail = asString(await response.text());
    throw new Error(`Read API start failed (${response.status}): ${detail || response.statusText}`);
  }

  const operationLocation = asString(response.headers.get("operation-location"));
  if (!operationLocation) {
    throw new Error("Read API did not return an operation-location header.");
  }
  return operationLocation;
}

async function pollReadOperation(operationLocation, apiKey) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(operationLocation, {
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey
      }
    });

    if (!response.ok) {
      const detail = asString(await response.text());
      throw new Error(`Read API poll failed (${response.status}): ${detail || response.statusText}`);
    }

    const payload = await response.json();
    const status = asString(payload && payload.status).toLowerCase();
    if (status === "succeeded") return payload;
    if (status === "failed") {
      throw new Error("Read API failed to recognize text.");
    }

    await delay(650);
  }

  throw new Error("Read API timed out while processing the image.");
}

function extractReadText(payload) {
  const readResults = payload && payload.analyzeResult && Array.isArray(payload.analyzeResult.readResults)
    ? payload.analyzeResult.readResults
    : [];
  const lines = [];
  for (const page of readResults) {
    const pageLines = page && Array.isArray(page.lines) ? page.lines : [];
    for (const line of pageLines) {
      const text = asString(line && line.text);
      if (text) lines.push(text);
    }
  }
  return lines.join("\n");
}

async function performAzureRead(endpoint, apiKey, bytes) {
  const operationLocation = await startReadOperation(endpoint, apiKey, bytes);
  const result = await pollReadOperation(operationLocation, apiKey);
  return extractReadText(result);
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "POST";
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  if (method !== "POST") {
    context.res = json(405, { error: "Method not allowed." });
    return;
  }

  const endpoint = sanitizeEndpoint(process.env.VIN_OCR_ENDPOINT || process.env.AZURE_VISION_ENDPOINT);
  const apiKey = asString(process.env.VIN_OCR_KEY || process.env.AZURE_VISION_KEY);
  if (!endpoint || !apiKey) {
    context.res = json(500, {
      error: "VIN OCR is not configured. Missing VIN_OCR_ENDPOINT/VIN_OCR_KEY."
    });
    return;
  }

  const body = extractBody(req);
  const bytes = decodeBase64Payload(body.imageBase64 || body.imageDataUrl || "");
  if (!bytes || !bytes.length) {
    context.res = json(400, {
      error: "imageBase64 is required and must be a valid base64 image payload."
    });
    return;
  }

  if (bytes.length > 6 * 1024 * 1024) {
    context.res = json(400, {
      error: "Image is too large. Maximum size is 6MB."
    });
    return;
  }

  try {
    const text = await performAzureRead(endpoint, apiKey, bytes);
    const candidates = collectVinCandidates(text);
    context.res = json(200, {
      ok: true,
      vin: candidates[0] || "",
      candidates
    });
  } catch (err) {
    context.res = json(502, {
      ok: false,
      error: asString(err && err.message) || "VIN OCR request failed."
    });
  }
};
