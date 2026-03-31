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
    .replace(/[^A-Z0-9]/g, "");
}

function isVin(value) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(asString(value));
}

const VIN_TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function vinCheckDigit(vin) {
  const raw = asString(vin).toUpperCase();
  if (!isVin(raw)) return "";
  let sum = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const value = VIN_TRANSLITERATION[ch];
    if (typeof value !== "number") return "";
    sum += value * VIN_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder === 10 ? "X" : String(remainder);
}

function hasValidVinChecksum(vin) {
  const raw = asString(vin).toUpperCase();
  if (!isVin(raw)) return false;
  return raw[8] === vinCheckDigit(raw);
}

function vinVariants(rawCandidate) {
  const base = normalizeVinChars(rawCandidate);
  if (base.length !== 17) return [];
  const variants = new Set([base, base.replace(/I/g, "1").replace(/[OQ]/g, "0")]);
  return Array.from(variants).filter(isVin);
}

function collectVinCandidates(text) {
  const strong = [];
  const weak = [];
  const seen = new Set();
  const pushCandidate = candidate => {
    for (const normalized of vinVariants(candidate)) {
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (hasValidVinChecksum(normalized)) {
        strong.push(normalized);
      } else {
        weak.push(normalized);
      }
    }
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

  return { strong, weak };
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
    const { strong, weak } = collectVinCandidates(text);
    const candidates = strong;
    context.res = json(200, {
      ok: true,
      vin: candidates[0] || "",
      candidates,
      weakCandidates: weak.slice(0, 5)
    });
  } catch (err) {
    context.res = json(502, {
      ok: false,
      error: asString(err && err.message) || "VIN OCR request failed."
    });
  }
};
