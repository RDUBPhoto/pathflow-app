function asString(value) {
  return value == null ? "" : String(value).trim();
}

function readQueryParam(req, key) {
  if (req.query && req.query[key] != null) return asString(req.query[key]);
  const rawUrl = asString(req.url);
  if (!rawUrl || rawUrl.indexOf("?") < 0) return "";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
}

function slugify(value) {
  return asString(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueNonEmpty(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const item = asString(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function buildSlugCandidates(value) {
  const raw = asString(value).toLowerCase();
  const slug = slugify(value);
  const compact = slug.replace(/-/g, "");
  return uniqueNonEmpty([slug, raw, compact]);
}

function buildSearchPlans({ year, trim, region }) {
  const plans = [
    { year, trim, region },
    { year, trim, region: "" },
    { year, trim: "", region },
    { year, trim: "", region: "" },
    { year: "", trim: "", region },
    { year: "", trim: "", region: "" }
  ];

  const seen = new Set();
  const out = [];
  for (const plan of plans) {
    const key = JSON.stringify({
      year: asString(plan.year),
      trim: asString(plan.trim),
      region: asString(plan.region)
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(plan);
  }
  return out;
}

async function requestWheelSize(baseUrl, apiKey, params) {
  const query = new URLSearchParams();
  query.set("user_key", apiKey);
  query.set("make", params.make);
  query.set("model", params.model);
  if (params.year) query.set("year", params.year);
  if (params.trim) query.set("trim", params.trim);
  if (params.region) query.set("region", params.region);

  const url = `${baseUrl}/search/by_model/?${query.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_) {}

  if (!response.ok) {
    const detail = asString(parsed.error || parsed.detail || text || response.statusText);
    throw new Error(`Wheel-Size request failed (${response.status}): ${detail || "Unknown provider response."}`);
  }
  return parsed;
}

function scoreModification(item, trimQuery, year) {
  let score = 0;
  if (Array.isArray(item.wheels) && item.wheels.length) score += 3;
  const trim = asString(item.trim || item.name).toLowerCase();
  if (trimQuery && trim) {
    if (trim === trimQuery) score += 8;
    else if (trim.includes(trimQuery)) score += 4;
  }

  const startYear = Number(item.start_year);
  const endYear = Number(item.end_year);
  const yearNum = Number(year);
  if (Number.isFinite(yearNum)) {
    if (Number.isFinite(startYear) && Number.isFinite(endYear) && yearNum >= startYear && yearNum <= endYear) {
      score += 2;
    }
  }

  if (asString(item.body)) score += 1;
  if (item.technical && typeof item.technical === "object") score += 1;
  return score;
}

function chooseModification(items, trim, year) {
  if (!Array.isArray(items) || !items.length) return null;
  const trimQuery = asString(trim).toLowerCase();
  const ranked = items
    .map(item => ({ item, score: scoreModification(item, trimQuery, year) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0] ? ranked[0].item : null;
}

function formatFasteners(technical) {
  const fasteners = technical && technical.wheel_fasteners && typeof technical.wheel_fasteners === "object"
    ? technical.wheel_fasteners
    : {};
  const type = asString(fasteners.type);
  const thread = asString(fasteners.thread_size);
  if (type && thread) return `${type} ${thread}`;
  return type || thread || "";
}

function normalizeRim(frontRear) {
  if (!frontRear || typeof frontRear !== "object") return "";
  const rim = asString(frontRear.rim);
  if (rim) return rim;
  const diameter = asString(frontRear.rim_diameter);
  const width = asString(frontRear.rim_width);
  const offset = asString(frontRear.rim_offset);
  const parts = [];
  if (width && diameter) parts.push(`${width}Jx${diameter}`);
  else if (diameter) parts.push(`${diameter}"`);
  if (offset) parts.push(`ET${offset}`);
  return parts.join(" ").trim();
}

function normalizeTire(frontRear) {
  if (!frontRear || typeof frontRear !== "object") return "";
  return asString(frontRear.tire_full || frontRear.tire || "");
}

function extractFitment(modification) {
  if (!modification || typeof modification !== "object") return null;
  const technical = modification.technical && typeof modification.technical === "object"
    ? modification.technical
    : {};
  const wheels = Array.isArray(modification.wheels) ? modification.wheels : [];
  const primaryWheel = wheels.find(item => item && item.is_stock) || wheels[0] || {};
  const front = primaryWheel.front && typeof primaryWheel.front === "object" ? primaryWheel.front : {};
  const rear = primaryWheel.rear && typeof primaryWheel.rear === "object" ? primaryWheel.rear : front;

  const fitment = {
    boltPattern: asString(technical.bolt_pattern),
    rearBoltPattern: asString(technical.rear_axis_bolt_pattern),
    pcd: asString(technical.pcd),
    rearPcd: asString(technical.rear_axis_pcd),
    centreBore: asString(technical.centre_bore),
    wheelFasteners: formatFasteners(technical),
    wheelTorque: asString(technical.wheel_tightening_torque),
    frontTireSize: normalizeTire(front),
    rearTireSize: normalizeTire(rear),
    frontRimSize: normalizeRim(front),
    rearRimSize: normalizeRim(rear)
  };

  const hasSignal = Object.values(fitment).some(value => !!asString(value));
  return hasSignal ? fitment : null;
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  if (method !== "GET") {
    context.res = json(405, { error: "Method not allowed" });
    return;
  }

  try {
    const apiKey = asString(process.env.WHEEL_SIZE_API_KEY);
    if (!apiKey) {
      context.res = json(500, {
        error: "Missing WHEEL_SIZE_API_KEY."
      });
      return;
    }

    const makeInput = readQueryParam(req, "make");
    const modelInput = readQueryParam(req, "model");
    const year = readQueryParam(req, "year");
    const trim = readQueryParam(req, "trim");
    const region = readQueryParam(req, "region") || "usdm";

    if (!makeInput || !modelInput) {
      context.res = json(400, { error: "make and model are required." });
      return;
    }

    const baseUrl = asString(process.env.WHEEL_SIZE_BASE_URL) || "https://api.wheel-size.com/v2";
    const makeCandidates = buildSlugCandidates(makeInput).slice(0, 3);
    const modelCandidates = buildSlugCandidates(modelInput).slice(0, 3);

    let data = [];
    let attempted = null;
    const searchPlans = buildSearchPlans({ year, trim, region });

    for (const make of makeCandidates) {
      for (const model of modelCandidates) {
        for (const plan of searchPlans) {
          const response = await requestWheelSize(baseUrl, apiKey, {
            make,
            model,
            year: plan.year,
            trim: plan.trim,
            region: plan.region
          });
          const next = Array.isArray(response.data) ? response.data : [];
          attempted = {
            make,
            model,
            year: asString(plan.year),
            trim: asString(plan.trim),
            region: asString(plan.region)
          };
          if (next.length) {
            data = next;
            break;
          }
        }
        if (data.length) break;
      }
      if (data.length) break;
    }

    if (!data.length) {
      context.res = json(200, {
        ok: true,
        source: "wheel-size",
        attempted,
        fitment: null,
        message: "No fitment data found for this vehicle."
      });
      return;
    }

    const modification = chooseModification(data, trim, year);
    const fitment = extractFitment(modification);

    context.res = json(200, {
      ok: true,
      source: "wheel-size",
      attempted,
      matched: modification ? {
        slug: asString(modification.slug),
        trim: asString(modification.trim || modification.name),
        body: asString(modification.body)
      } : null,
      totalResults: data.length,
      fitment
    });
  } catch (err) {
    context.log.error(err);
    context.res = json(502, {
      error: "Fitment lookup failed.",
      detail: String((err && err.message) || err)
    });
  }
};
