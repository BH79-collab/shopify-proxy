const http  = require("http");
const https = require("https");

const PORT         = process.env.PORT || 3001;
const HOST         = "0.0.0.0";
const STRIPE_KEY   = process.env.STRIPE_KEY || "";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "x-shopify-token, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ── Generic HTTPS request ─────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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

// ── Stripe helper ─────────────────────────────────────────────────────────────
async function stripePost(path, params) {
  const body = new URLSearchParams(params).toString();
  const res  = await httpsRequest({
    hostname: "api.stripe.com",
    path,
    method:  "POST",
    headers: {
      "Authorization":  "Bearer " + STRIPE_KEY,
      "Content-Type":   "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  return { status: res.status, data: JSON.parse(res.body) };
}

// ── Main server ───────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    res.writeHead(204); return res.end();
  }

  let u;
  try { u = new URL(req.url, "http://localhost"); }
  catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad url" })); }

  // ── POST /stripe/subscribe ──────────────────────────────────────────────────
  if (req.method === "POST" && u.pathname === "/stripe/subscribe") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { email, name, priceId, paymentMethodId } = JSON.parse(body);
        if (!email || !priceId || !paymentMethodId) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "missing fields" }));
        }

        // 1. Create customer
        const cust = await stripePost("/v1/customers", { email, name });
        if (cust.status !== 200) {
          res.writeHead(cust.status);
          return res.end(JSON.stringify({ error: cust.data.error?.message || "customer failed" }));
        }
        const customerId = cust.data.id;

        // 2. Attach payment method
        await stripePost(`/v1/payment_methods/${paymentMethodId}/attach`, {
          customer: customerId,
        });

        // 3. Set as default
        await stripePost(`/v1/customers/${customerId}`, {
          "invoice_settings[default_payment_method]": paymentMethodId,
        });

        // 4. Create subscription
        const sub = await stripePost("/v1/subscriptions", {
          customer:               customerId,
          "items[0][price]":      priceId,
          payment_behavior:       "default_incomplete",
          "expand[0]":            "latest_invoice.payment_intent",
        });

        if (sub.status !== 200) {
          res.writeHead(sub.status);
          return res.end(JSON.stringify({ error: sub.data.error?.message || "subscription failed" }));
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          subscriptionId: sub.data.id,
          customerId,
          status:         sub.data.status,
          clientSecret:   sub.data.latest_invoice?.payment_intent?.client_secret || null,
        }));

      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /shopify ────────────────────────────────────────────────────────────
  if (u.pathname === "/shopify") {
    const store = u.searchParams.get("store");
    const path  = u.searchParams.get("path");
    const token = req.headers["x-shopify-token"];

    if (!store || !path || !token) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "missing store, path or token" }));
    }

    const clean  = store.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const target = new URL("https://" + clean + "/admin/api/2024-01/" + path);

    try {
      const sr = await httpsRequest({
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
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));

}).listen(PORT, HOST, () => {
  console.log(`Proxy ready on http://${HOST}:${PORT}`);
});
