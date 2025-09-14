// netlify/functions/proxy.js
// Node 14+ (Netlify) / AWS Lambda style handler using node-fetch
const fetch = require("node-fetch");

const DEFAULT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // change to specific origin(s) if needed
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-API-Key, X-Forward-Path, x-forward-path, Accept",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS, DELETE",
  "Access-Control-Allow-Credentials": "false",
  "Access-Control-Max-Age": "86400",
};

function headerCI(obj = {}, key) {
  const lower = Object.keys(obj || {}).reduce((acc, k) => {
    acc[k.toLowerCase()] = obj[k];
    return acc;
  }, {});
  return lower[key.toLowerCase()];
}

function parseRawQueryToObj(raw) {
  const out = {};
  if (!raw || typeof raw !== "string") return out;
  const qs = raw.replace(/^\?/, "");
  if (!qs) return out;
  for (const p of qs.split("&")) {
    if (!p) continue;
    const idx = p.indexOf("=");
    if (idx === -1) {
      out[decodeURIComponent(p)] = "";
    } else {
      const k = decodeURIComponent(p.slice(0, idx));
      const v = decodeURIComponent(p.slice(idx + 1));
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

exports.handler = async function (event, context) {
  const corsHeaders = DEFAULT_CORS_HEADERS;

  // Preflight
  const method = (event.httpMethod || event.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  try {
    // Optional proxy API key check
    const REQUIRED_KEY = process.env.PROXY_API_KEY || "";
    if (REQUIRED_KEY) {
      const incomingKey = headerCI(event.headers, "x-api-key") || "";
      if (!incomingKey || incomingKey !== REQUIRED_KEY) {
        return {
          statusCode: 401,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: "invalid_api_key" }),
        };
      }
    }

    // Build payload
    let payload = null;
    if (method === "GET") {
      payload = event.queryStringParameters || {};
    } else {
      if (!event.body) {
        // Allow empty POSTs but return 400 for clarity
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: "empty_body" }),
        };
      }
      try {
        payload = JSON.parse(event.body);
      } catch (err) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: "invalid_json" }),
        };
      }
    }

    // Where to forward
    const N8N_WEBHOOK_URL = "https://n8n.dakshjain.me/webhook";
    if (!N8N_WEBHOOK_URL) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: "missing_n8n_webhook_env" }),
      };
    }

    // Determine extra path to append
    const queryPath = (event.queryStringParameters && event.queryStringParameters.path) || "";
    const headerPath = headerCI(event.headers, "x-forward-path") || "";
    const extraPath = (queryPath || headerPath || "").toString();

    let upstreamUrl = N8N_WEBHOOK_URL;
    if (extraPath) {
      // if client passes a full URL, use it
      if (/^https?:\/\//i.test(extraPath)) upstreamUrl = extraPath;
      else upstreamUrl = `${N8N_WEBHOOK_URL}/${extraPath.replace(/^\/+/, "")}`;
    }

    // Build headers to send upstream
    const upstreamHeaders = {};
    if (method !== "GET") upstreamHeaders["Content-Type"] = "application/json";

    // If N8N basic auth is configured via env, use it
    const N8N_USER = process.env.N8N_USER || "";
    const N8N_PASS = process.env.N8N_PASS || "";
    if (N8N_USER && N8N_PASS) {
      const creds = Buffer.from(`${N8N_USER}:${N8N_PASS}`).toString("base64");
      upstreamHeaders["Authorization"] = `Basic ${creds}`;
    } else {
      // otherwise forward incoming Authorization if provided
      const incomingAuth = headerCI(event.headers, "authorization") || "";
      if (incomingAuth) upstreamHeaders["Authorization"] = incomingAuth;
    }

    // Forward some common headers
    const forwardHeaderNames = ["x-api-key", "x-request-id", "user-agent", "accept"];
    for (const hn of forwardHeaderNames) {
      const val = headerCI(event.headers, hn);
      if (val) upstreamHeaders[hn] = val;
    }

    // Build fetch URL (preserve extra query params except 'path')
    let upstreamFetchUrl = upstreamUrl;
    if (method === "GET") {
      let incomingQs = {};
      if (event.queryStringParameters && Object.keys(event.queryStringParameters).length) {
        incomingQs = event.queryStringParameters;
      } else if (event.rawQuery && typeof event.rawQuery === "string") {
        incomingQs = parseRawQueryToObj(event.rawQuery);
      }
      // remove path param if present
      delete incomingQs.path;
      const qsEntries = Object.entries(incomingQs);
      if (qsEntries.length) {
        const qsParts = [];
        for (const [k, v] of qsEntries) {
          if (Array.isArray(v)) {
            for (const vv of v) {
              qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(vv)}`);
            }
          } else {
            qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
          }
        }
        const qs = qsParts.join("&");
        upstreamFetchUrl = upstreamUrl + (upstreamUrl.includes("?") ? "&" : "?") + qs;
      }
    }

    const fetchOptions = {
      method,
      headers: upstreamHeaders,
    };
    if (method !== "GET" && payload !== null) fetchOptions.body = JSON.stringify(payload);

    const resp = await fetch(upstreamFetchUrl, fetchOptions);
    const text = await resp.text().catch(() => "");

    // try to parse JSON friendly message
    let message = "";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        // pick a useful field if present
        const candidate = ["message", "text", "response", "body", "result"];
        for (const c of candidate) {
          if (Object.prototype.hasOwnProperty.call(parsed, c)) {
            if (typeof parsed[c] === "string") {
              message = parsed[c];
              break;
            } else {
              message = JSON.stringify(parsed[c]);
              break;
            }
          }
        }
        if (!message) message = JSON.stringify(parsed);
      } else {
        message = String(parsed);
      }
    } catch (e) {
      message = text;
    }

    return {
      statusCode: typeof resp.status === "number" ? resp.status : (resp.ok ? 200 : 502),
      headers: corsHeaders,
      body: JSON.stringify({
        ok: !!resp.ok,
        status: resp.status,
        upstreamBody: text,
        message,
      }),
    };
  } catch (err) {
    console.error("proxy error", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: false,
        error: "internal_error",
        details: err && err.message ? err.message : String(err),
      }),
    };
  }
};
