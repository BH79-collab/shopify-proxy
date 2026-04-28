const http  = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT       = process.env.PORT || 3001;
const HOST       = "0.0.0.0";
const STRIPE_KEY = process.env.STRIPE_KEY  || "";
const WHSEC      = process.env.STRIPE_WEBHOOK_SECRET || "";
const SUPA_URL   = "https://xwennpgxsndjpbwdmcwk.supabase.co";
const SUPA_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3ZW5ucGd4c25kanBid2RtY3drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODc1MjksImV4cCI6MjA5MjU2MzUyOX0.LAyCQtlsF9puLftwyK67qwsYED7PksZeP3QoD0lmuTA";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "x-shopify-token, Content-Type, stripe-signature",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function httpsReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

async function stripePost(path, params) {
  const body = new URLSearchParams(params).toString();
  const r = await httpsReq({
    hostname: "api.stripe.com", path, method: "POST",
    headers: {
      "Authorization":  "Bearer " + STRIPE_KEY,
      "Content-Type":   "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  return { status: r.status, data: JSON.parse(r.body) };
}

async function supabasePatch(table, match, update) {
  const params = new URLSearchParams(match).toString();
  const body   = JSON.stringify(update);
  return httpsReq({
    hostname: SUPA_URL.replace("https://",""),
    path:     `/rest/v1/${table}?${params}`,
    method:   "PATCH",
    headers: {
      "apikey":          SUPA_KEY,
      "Authorization":   "Bearer " + SUPA_KEY,
      "Content-Type":    "application/json",
      "Content-Length":  Buffer.byteLength(body),
      "Prefer":          "return=minimal",
    },
  }, body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  let u;
  try { u = new URL(req.url, "http://localhost"); }
  catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad url" })); }

  // ── POST /stripe/checkout ──────────────────────────────────────────────────
  if (req.method === "POST" && u.pathname === "/stripe/checkout") {
    const raw = await readBody(req);
    try {
      const { priceId, successUrl, cancelUrl, email, name, metadata } = JSON.parse(raw.toString());
      if (!priceId || !successUrl || !cancelUrl) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "missing fields" }));
      }
      const params = new URLSearchParams({
        mode:                      "subscription",
        "line_items[0][price]":    priceId,
        "line_items[0][quantity]": "1",
        success_url:               successUrl,
        cancel_url:                cancelUrl,
        customer_email:            email || "",
      });
      if (name) params.append("subscription_data[metadata][vendor_name]", name);
      if (metadata) {
        Object.entries(metadata).forEach(([k, v]) => {
          params.append(`metadata[${k}]`, String(v).slice(0, 500));
        });
      }
      const body = params.toString();
      const r = await httpsReq({
        hostname: "api.stripe.com",
        path:     "/v1/checkout/sessions",
        method:   "POST",
        headers: {
          "Authorization":  "Bearer " + STRIPE_KEY,
          "Content-Type":   "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      }, body);
      const data = JSON.parse(r.body);
      if (r.status !== 200) {
        res.writeHead(r.status);
        return res.end(JSON.stringify({ error: data.error?.message || "Checkout failed" }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: data.url, sessionId: data.id }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /stripe/subscribe ─────────────────────────────────────────────────
  if (req.method === "POST" && u.pathname === "/stripe/subscribe") {
    const raw = await readBody(req);
    try {
      const { email, name, priceId, paymentMethodId } = JSON.parse(raw.toString());
      if (!email || !priceId || !paymentMethodId) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "missing fields" }));
      }
      const cust = await stripePost("/v1/customers", { email, name });
      if (cust.status !== 200) {
        res.writeHead(cust.status);
        return res.end(JSON.stringify({ error: cust.data.error?.message }));
      }
      const customerId = cust.data.id;
      await stripePost(`/v1/payment_methods/${paymentMethodId}/attach`, { customer: customerId });
      await stripePost(`/v1/customers/${customerId}`, {
        "invoice_settings[default_payment_method]": paymentMethodId,
      });
      const sub = await stripePost("/v1/subscriptions", {
        customer:          customerId,
        "items[0][price]": priceId,
        payment_behavior:  "default_incomplete",
        "expand[0]":       "latest_invoice.payment_intent",
      });
      if (sub.status !== 200) {
        res.writeHead(sub.status);
        return res.end(JSON.stringify({ error: sub.data.error?.message }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        subscriptionId: sub.data.id,
        customerId,
        status:       sub.data.status,
        clientSecret: sub.data.latest_invoice?.payment_intent?.client_secret || null,
      }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /stripe/webhook ───────────────────────────────────────────────────
  if (req.method === "POST" && u.pathname === "/stripe/webhook") {
    const raw = await readBody(req);
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      const parts    = sig.split(",").reduce((acc, p) => { const [k, v] = p.split("="); acc[k] = v; return acc; }, {});
      const payload  = `${parts.t}.${raw.toString()}`;
      const expected = crypto.createHmac("sha256", WHSEC).update(payload).digest("hex");
      if (expected !== parts.v1) throw new Error("signature mismatch");
      event = JSON.parse(raw.toString());
    } catch (e) {
      res.writeHead(400); return res.end(JSON.stringify({ error: e.message }));
    }
    try {
      const obj = event.data.object;
      if (event.type === "invoice.payment_succeeded") {
        const subId = obj.subscription;
        if (subId) await supabasePatch("subscriptions", { stripe_subscription_id: `eq.${subId}` }, { status: "active" });
      }
      if (event.type === "invoice.payment_failed") {
        const subId = obj.subscription;
        if (subId) {
          await supabasePatch("subscriptions", { stripe_subscription_id: `eq.${subId}` }, { status: "past_due" });
          const subRes = await httpsReq({
            hostname: SUPA_URL.replace("https://",""),
            path:     `/rest/v1/subscriptions?stripe_subscription_id=eq.${subId}&select=vendor_id`,
            method:   "GET",
            headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY },
          });
          const subs = JSON.parse(subRes.body);
          if (subs.length) await supabasePatch("vendors", { id: `eq.${subs[0].vendor_id}` }, { status: "paused" });
        }
      }
      if (event.type === "customer.subscription.deleted") {
        await supabasePatch("subscriptions", { stripe_subscription_id: `eq.${obj.id}` }, { status: "cancelled" });
      }
      // Handle checkout session completed
      if (event.type === "checkout.session.completed") {
        const sessionId = obj.id;
        const subId = obj.subscription;
        if (subId) await supabasePatch("subscriptions", { stripe_subscription_id: `eq.${sessionId}` }, { stripe_subscription_id: subId, status: "active" });
      }
    } catch (e) {
      console.error("Webhook handler error:", e.message);
    }
    res.writeHead(200); res.end(JSON.stringify({ received: true }));
    return;
  }

  // ── GET /shopify ───────────────────────────────────────────────────────────
  if (u.pathname === "/shopify") {
    const store = u.searchParams.get("store");
    const path  = u.searchParams.get("path");
    const token = req.headers["x-shopify-token"];
    if (!store || !path || !token) {
      res.writeHead(400); return res.end(JSON.stringify({ error: "missing params" }));
    }
    const clean  = store.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const target = new URL("https://" + clean + "/admin/api/2024-01/" + path);
    try {
      const sr = await httpsReq({
        hostname: target.hostname,
        path:     target.pathname + target.search,
        method:   "GET",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type":           "application/json",
          "Accept":                 "application/json",
        },
      });
      res.writeHead(sr.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(sr.body);
    } catch (e) {
      res.writeHead(502); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));

}).listen(PORT, HOST, () => {
  console.log(`Proxy ready on http://${HOST}:${PORT}`);
});
