const http  = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT       = process.env.PORT || 3001;
const HOST       = "0.0.0.0";
const STRIPE_KEY = process.env.STRIPE_KEY  || "";
const WHSEC      = process.env.STRIPE_WEBHOOK_SECRET || "";
const SUPA_URL   = "https://xwennpgxsndjpbwdmcwk.supabase.co";
const SUPA_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3ZW5ucGd4c25kanBid2RtY3drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODc1MjksImV4cCI6MjA5MjU2MzUyOX0.LAyCQtlsF9puLftwyK67qwsYED7PksZeP3QoD0lmuTA";
// Service-role key bypasses Row Level Security — required for every write this
// proxy makes on a vendor's behalf (vendor creation, subscription/order writes).
// Set SUPABASE_SERVICE_ROLE_KEY in Railway's environment variables; never commit it.
// Falls back to the anon key so the proxy keeps working before RLS is enabled,
// but writes will start failing with 401/403 once RLS is on unless this is set.
const SUPA_WRITE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_KEY;
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("SUPABASE_SERVICE_ROLE_KEY is not set — falling back to the anon key for writes. This will break once RLS is enabled on the vendors/orders/payments/subscriptions tables.");
}

// Shopify Storefront API — canonical *.myshopify.com handle, not a connected
// alias domain (aliases 401 on the Storefront API even when "Connected").
const SF_DOMAIN  = "9b4aaf.myshopify.com";
const SF_VERSION = "2026-07";
// Private Storefront token — server-side only, per Shopify's own warning never
// to expose it publicly. Set SHOPIFY_STOREFRONT_PRIVATE_TOKEN in Railway.
const SF_PRIVATE_TOKEN = process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN || "";
if (!SF_PRIVATE_TOKEN) {
  console.warn("SHOPIFY_STOREFRONT_PRIVATE_TOKEN is not set — GET /shopify/products will fail.");
}

// Admin API token — write access, used only for the admin "Approve & Publish
// to Shopify" action (creates live products/collections). Far more
// privileged than the Storefront token; never sent to any client.
// Set SHOPIFY_ADMIN_API_TOKEN in Railway.
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || "";
if (!SHOPIFY_ADMIN_TOKEN) {
  console.warn("SHOPIFY_ADMIN_API_TOKEN is not set — POST /shopify/publish-vendor will fail.");
}
const RETAIL_MARKUP = 20; // added to the base product's price for the vendor's branded listing

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
  const r = await httpsReq({
    hostname: SUPA_URL.replace("https://",""),
    path:     `/rest/v1/${table}?${params}`,
    method:   "PATCH",
    headers: {
      "apikey":          SUPA_WRITE_KEY,
      "Authorization":   "Bearer " + SUPA_WRITE_KEY,
      "Content-Type":    "application/json",
      "Content-Length":  Buffer.byteLength(body),
      "Prefer":          "return=minimal",
    },
  }, body);
  if (r.status >= 300) throw new Error(`Supabase PATCH ${table} failed (${r.status}): ${r.body}`);
  return r;
}

async function supabaseGet(path) {
  return httpsReq({
    hostname: SUPA_URL.replace("https://", ""),
    path,
    method:   "GET",
    headers: { "apikey": SUPA_WRITE_KEY, "Authorization": "Bearer " + SUPA_WRITE_KEY },
  });
}

async function supabasePost(table, body, prefer) {
  const b = JSON.stringify(body);
  const r = await httpsReq({
    hostname: SUPA_URL.replace("https://", ""),
    path:     `/rest/v1/${table}`,
    method:   "POST",
    headers: {
      "apikey":         SUPA_WRITE_KEY,
      "Authorization":  "Bearer " + SUPA_WRITE_KEY,
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(b),
      "Prefer":         prefer || "return=minimal",
    },
  }, b);
  if (r.status >= 300) throw new Error(`Supabase POST ${table} failed (${r.status}): ${r.body}`);
  return r;
}

// Insert or update the vendor row by email, and always set auth_user_id so
// index.html can look the vendor up by their Supabase Auth session.
async function upsertVendor(email, authUserId, fields) {
  const existing = await supabaseGet(`/rest/v1/vendors?email=eq.${encodeURIComponent(email)}&select=id`);
  const rows = JSON.parse(existing.body || "[]");
  const payload = { ...fields, email, auth_user_id: authUserId || null };
  if (rows.length) {
    await supabasePatch("vendors", { id: `eq.${rows[0].id}` }, payload);
    return { id: rows[0].id, created: false };
  }
  const created = await supabasePost("vendors", payload, "return=representation");
  const vendor = JSON.parse(created.body || "[]")[0];
  return { id: vendor?.id, created: true };
}

async function supabaseDelete(path) {
  const r = await httpsReq({
    hostname: SUPA_URL.replace("https://", ""),
    path,
    method: "DELETE",
    headers: { "apikey": SUPA_WRITE_KEY, "Authorization": "Bearer " + SUPA_WRITE_KEY, "Prefer": "return=minimal" },
  });
  if (r.status >= 300) throw new Error(`Supabase DELETE ${path} failed (${r.status}): ${r.body}`);
  return r;
}

// ── Shopify Admin API (write access — publishing only) ──────────────────────
async function shopifyAdminReq(method, path, body) {
  const b = body ? JSON.stringify(body) : null;
  const headers = {
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json",
  };
  if (b) headers["Content-Length"] = Buffer.byteLength(b);
  const r = await httpsReq({
    hostname: SF_DOMAIN,
    path: `/admin/api/${SF_VERSION}${path}`,
    method,
    headers,
  }, b);
  let data;
  try { data = JSON.parse(r.body || "{}"); } catch { data = {}; }
  return { status: r.status, data };
}

// Storefront GIDs look like "gid://shopify/Product/9350089474336" — the
// Admin REST API wants just the trailing numeric id.
function numericIdFromGid(gid) {
  const m = String(gid || "").match(/(\d+)$/);
  return m ? m[1] : null;
}

async function getBaseProduct(productGid) {
  const id = numericIdFromGid(productGid);
  if (!id) return null;
  const { status, data } = await shopifyAdminReq("GET", `/products/${id}.json`);
  if (status !== 200 || !data.product) return null;
  return data.product;
}

// Finds the vendor's custom collection by title (matches what the old manual
// "Setup in Shopify" flow created), or creates one if it doesn't exist yet.
async function findOrCreateCollection(title) {
  const search = await shopifyAdminReq("GET", `/custom_collections.json?title=${encodeURIComponent(title)}`);
  const existing = search.data?.custom_collections?.find(c => c.title === title);
  if (existing) return existing.id;

  const created = await shopifyAdminReq("POST", "/custom_collections.json", {
    custom_collection: { title, published: true },
  });
  if (created.status !== 201 || !created.data.custom_collection) {
    throw new Error("Could not create Shopify collection: " + JSON.stringify(created.data));
  }
  return created.data.custom_collection.id;
}

async function addProductToCollection(productId, collectionId) {
  await shopifyAdminReq("POST", "/collects.json", {
    collect: { product_id: productId, collection_id: collectionId },
  });
}

// Replaces a vendor's product/logo selection wholesale from the onboarding
// wizard's productSlots JSON. Called only from /vendor/save, which receives
// the full untruncated data as a JSON body — Stripe checkout metadata caps
// each value at 500 characters, so this can't safely go through the webhook.
async function replaceVendorProducts(vendorId, productSlotsJson) {
  let slots;
  try { slots = JSON.parse(productSlotsJson || "[]"); } catch { slots = []; }
  slots = (slots || []).filter(s => s && s.productId);

  await supabaseDelete(`/rest/v1/vendor_products?vendor_id=eq.${vendorId}`);
  if (!slots.length) return;

  await supabasePost("vendor_products", slots.map(s => ({
    vendor_id:       vendorId,
    product_id:      s.productId,
    colours:         s.colours || [],
    sizes:           s.sizes || [],
    front_logo_url:  s.frontLogo?.url || null,
    back_logo_url:   s.backLogo?.url || null,
    front_placement: s.frontPl || null,
    back_placement:  s.backPl || null,
  })));
}

// Creates a live Shopify product for one vendor_products row: looks up the
// base product's price (+ RETAIL_MARKUP), builds colour/size variants,
// attaches the pre-generated mockup image(s), and adds it to the vendor's
// collection. Returns the created product's numeric id.
async function publishVendorProduct(vendor, vp, collectionId) {
  const base = await getBaseProduct(vp.product_id);
  if (!base) throw new Error(`Base Shopify product not found for ${vp.product_id}`);

  const basePrice = parseFloat(base.variants?.[0]?.price || "0");
  const price = (basePrice + RETAIL_MARKUP).toFixed(2);
  const brandName = vendor.brand_name || vendor.store_name || vendor.name || "Vendor";

  const colours = (vp.colours || []).length ? vp.colours : [null];
  const sizes   = (vp.sizes   || []).length ? vp.sizes   : [null];
  const options = [];
  if (vp.colours?.length) options.push({ name: "Colour", values: vp.colours });
  if (vp.sizes?.length)   options.push({ name: "Size",   values: vp.sizes });

  const variants = [];
  colours.forEach(c => {
    sizes.forEach(s => {
      const optionValues = [c, s].filter(v => v !== null);
      const variant = { price, inventory_management: null };
      optionValues.forEach((v, i) => { variant[`option${i + 1}`] = v; });
      variants.push(variant);
    });
  });

  const images = [];
  if (vp.front_mockup_url) images.push({ src: vp.front_mockup_url });
  if (vp.back_mockup_url)  images.push({ src: vp.back_mockup_url });

  const created = await shopifyAdminReq("POST", "/products.json", {
    product: {
      title: `${base.title} — ${brandName}`,
      vendor: brandName,
      product_type: base.product_type || "",
      status: "active",
      options: options.length ? options : undefined,
      variants,
      images,
    },
  });
  if (created.status !== 201 || !created.data.product) {
    throw new Error(`Shopify product creation failed: ${JSON.stringify(created.data)}`);
  }
  const productId = created.data.product.id;
  await addProductToCollection(productId, collectionId);
  return productId;
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

  // POST /stripe/checkout
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

  // POST /stripe/subscribe
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

  // POST /stripe/webhook
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
          const subRes = await supabaseGet(`/rest/v1/subscriptions?stripe_subscription_id=eq.${subId}&select=vendor_id`);
          const subs = JSON.parse(subRes.body);
          if (subs.length) await supabasePatch("vendors", { id: `eq.${subs[0].vendor_id}` }, { status: "paused" });
        }
      }
      if (event.type === "customer.subscription.deleted") {
        await supabasePatch("subscriptions", { stripe_subscription_id: `eq.${obj.id}` }, { status: "cancelled" });
      }
      if (event.type === "checkout.session.completed") {
        const subId = obj.subscription;
        const meta = obj.metadata || {};
        const planMap = {
          starter: { payout: 10, price: 29.95 },
          growth:  { payout: 12, price: 59.95 },
          pro:     { payout: 15, price: 99.95 },
        };
        const plan = planMap[meta.planId] || planMap.starter;

        // Save vendor to Supabase
        if (meta.vendorName && obj.customer_email) {
          const email = obj.customer_email.toLowerCase().trim();
          const { id: vendorId } = await upsertVendor(email, meta.authUserId, {
            name:           `${meta.firstName || ""} ${meta.lastName || ""}`.trim() || meta.vendorName,
            phone:          meta.phone || "",
            brand_name:     meta.vendorName,
            store_name:     meta.vendorName,
            address:        [meta.street, meta.suburb, meta.state, meta.postcode, meta.country].filter(Boolean).join(", "),
            bank:           meta.bankName || "",
            bsb:            meta.bsb || "",
            account_number: meta.accountNumber || "",
            account_name:   meta.accountName || "",
            plan:           meta.planId || "starter",
            payout_rate:    plan.payout,
            status:         "pending",
            notes:          JSON.stringify({ category: meta.category, stripeSessionId: obj.id }),
          });

          // Save subscription
          if (subId && vendorId) {
            await supabasePost("subscriptions", {
              vendor_id:               vendorId,
              plan:                    meta.planId || "starter",
              price:                   plan.price,
              payout_rate:             plan.payout,
              status:                  "active",
              stripe_subscription_id:  subId,
            });
          }
        }
      }
    } catch (e) {
      console.error("Webhook handler error:", e.message);
    }
    res.writeHead(200); res.end(JSON.stringify({ received: true }));
    return;
  }

  // POST /vendor/save — client-side fallback save, called by onboarding.html
  // after a successful Stripe redirect in case the /stripe/webhook call above
  // was missed or hasn't landed yet. Upserts by email, same as the webhook path.
  if (req.method === "POST" && u.pathname === "/vendor/save") {
    const raw = await readBody(req);
    try {
      const { meta, email, authUserId, subscriptionId } = JSON.parse(raw.toString());
      if (!meta || !email) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "missing meta or email" }));
      }
      const planMap = {
        starter: { payout: 10, price: 29.95 },
        growth:  { payout: 12, price: 59.95 },
        pro:     { payout: 15, price: 99.95 },
      };
      const plan = planMap[meta.planId] || planMap.starter;
      const cleanEmail = email.toLowerCase().trim();

      const { id: vendorId } = await upsertVendor(cleanEmail, authUserId, {
        name:           `${meta.firstName || ""} ${meta.lastName || ""}`.trim() || meta.vendorName,
        phone:          meta.phone || "",
        brand_name:     meta.vendorName,
        store_name:     meta.vendorName,
        address:        [meta.street, meta.suburb, meta.state, meta.postcode, meta.country].filter(Boolean).join(", "),
        bank:           meta.bankName || "",
        bsb:            meta.bsb || "",
        account_number: meta.accountNumber || "",
        account_name:   meta.accountName || "",
        plan:           meta.planId || "starter",
        payout_rate:    plan.payout,
        status:         "pending",
        notes:          JSON.stringify({ category: meta.category }),
      });

      if (vendorId) await replaceVendorProducts(vendorId, meta.productSlots);

      if (subscriptionId && vendorId) {
        const existingSub = await supabaseGet(`/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}&select=id`);
        if (!JSON.parse(existingSub.body || "[]").length) {
          await supabasePost("subscriptions", {
            vendor_id:              vendorId,
            plan:                   meta.planId || "starter",
            price:                  plan.price,
            payout_rate:            plan.payout,
            status:                 "active",
            stripe_subscription_id: subscriptionId,
          });
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ saved: true, vendorId }));
    } catch (e) {
      console.error("Vendor save error:", e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /shopify/orders (Shopify webhook saves orders to Supabase)
  if (req.method === "POST" && u.pathname === "/shopify/orders") {
    const raw = await readBody(req);
    try {
      const order = JSON.parse(raw.toString());
      const lineItems = (order.line_items || []).map(item => ({
        product_id: item.product_id?.toString(),
        title:      item.title,
        quantity:   item.quantity,
        price:      parseFloat(item.price),
        vendor:     item.vendor,
        sku:        item.sku,
      }));
      await supabasePost("orders", {
        shopify_order_id: order.id?.toString(),
        order_number:     order.order_number?.toString(),
        customer_name:    `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim(),
        customer_email:   order.customer?.email || "",
        total_price:      parseFloat(order.total_price || 0),
        line_items:       lineItems,
        status:           order.financial_status || "pending",
        created_at:       order.created_at,
      });
      res.writeHead(200); res.end(JSON.stringify({ received: true }));
    } catch (e) {
      console.error("Order webhook error:", e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /supabase/orders (payout app reads orders from Supabase)
  // NOTE: this endpoint is unauthenticated — it uses the service-role key to read
  // across all vendors, so anyone who can reach this proxy can call it. It needs
  // an access check (e.g. an admin-only header/token) before payout.html is
  // pointed at it; tracked separately from this auth fix.
  if (req.method === "GET" && u.pathname === "/supabase/orders") {
    try {
      const r = await supabaseGet("/rest/v1/orders?select=*&order=created_at.desc&limit=250");
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(r.body);
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /shopify/products — Storefront API product catalogue for onboarding.html.
  // Uses the private Storefront token server-side; the browser never sees it.
  if (req.method === "GET" && u.pathname === "/shopify/products") {
    if (!SF_PRIVATE_TOKEN) {
      res.writeHead(500); return res.end(JSON.stringify({ error: "Storefront token not configured" }));
    }
    const query = "{products(first:50){edges{node{id title handle productType images(first:2){edges{node{url}}} options{name values} variants(first:100){edges{node{id title selectedOptions{name value}}}}}}}}";
    try {
      const r = await httpsReq({
        hostname: SF_DOMAIN,
        path:     `/api/${SF_VERSION}/graphql.json`,
        method:   "POST",
        headers: {
          "Content-Type":                  "application/json",
          "Shopify-Storefront-Private-Token": SF_PRIVATE_TOKEN,
        },
      }, JSON.stringify({ query }));
      res.writeHead(r.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(r.body);
    } catch (e) {
      res.writeHead(502); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /shopify/publish-vendor — admin-triggered: creates a live Shopify
  // product (with composited mockup image, price = base + markup) for each
  // of a vendor's chosen products, in their brand collection. Expects the
  // client to have already generated and saved mockup URLs onto the
  // vendor_products rows (compositing needs canvas/image work best done
  // browser-side) — this endpoint just does the privileged Shopify writes.
  if (req.method === "POST" && u.pathname === "/shopify/publish-vendor") {
    if (!SHOPIFY_ADMIN_TOKEN) {
      res.writeHead(500); return res.end(JSON.stringify({ error: "Shopify Admin API token not configured" }));
    }
    const raw = await readBody(req);
    try {
      const { vendorId } = JSON.parse(raw.toString());
      if (!vendorId) { res.writeHead(400); return res.end(JSON.stringify({ error: "missing vendorId" })); }

      const vendorRes = await supabaseGet(`/rest/v1/vendors?id=eq.${vendorId}&select=*`);
      const vendor = JSON.parse(vendorRes.body || "[]")[0];
      if (!vendor) { res.writeHead(404); return res.end(JSON.stringify({ error: "vendor not found" })); }

      const vpRes = await supabaseGet(`/rest/v1/vendor_products?vendor_id=eq.${vendorId}&select=*`);
      const products = JSON.parse(vpRes.body || "[]");

      const collectionTitle = vendor.brand_name || vendor.store_name || vendor.name || "Vendor";
      const collectionId = await findOrCreateCollection(collectionTitle);

      const results = [];
      for (const vp of products) {
        if (vp.shopify_product_id) {
          results.push({ productId: vp.product_id, status: "skipped", reason: "already published" });
          continue;
        }
        try {
          const shopifyProductId = await publishVendorProduct(vendor, vp, collectionId);
          await supabasePatch("vendor_products", { id: `eq.${vp.id}` }, {
            shopify_product_id: String(shopifyProductId),
            published_at: new Date().toISOString(),
          });
          results.push({ productId: vp.product_id, status: "published", shopifyProductId });
        } catch (e) {
          results.push({ productId: vp.product_id, status: "error", error: e.message });
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ collectionId, results }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /image-proxy?url=... — streams back an image with permissive CORS
  // headers regardless of the source's own CORS policy, so the admin's
  // browser can composite Shopify/Supabase-hosted images onto a <canvas>
  // for mockup generation without hitting a cross-origin taint error.
  // Restricted to known image hosts to avoid becoming an open SSRF proxy.
  if (req.method === "GET" && u.pathname === "/image-proxy") {
    const target = u.searchParams.get("url");
    let parsed;
    try { parsed = new URL(target); } catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad url" })); }
    const allowedHosts = [SF_DOMAIN, "cdn.shopify.com", SUPA_URL.replace("https://", "")];
    if (!allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))) {
      res.writeHead(403); return res.end(JSON.stringify({ error: "host not allowed" }));
    }
    https.get(parsed, upstream => {
      res.writeHead(upstream.statusCode, {
        "Content-Type": upstream.headers["content-type"] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      });
      upstream.pipe(res);
    }).on("error", e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // GET /shopify
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
