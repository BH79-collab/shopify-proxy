  // ── POST /stripe/checkout ─────────────────────────────────────────────────
  if (req.method === "POST" && u.pathname === "/stripe/checkout") {
    const raw = await readBody(req);
    try {
      const { priceId, successUrl, cancelUrl, email, name, metadata } = JSON.parse(raw.toString());
      if (!priceId || !successUrl || !cancelUrl) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "missing fields" }));
      }

      const params = new URLSearchParams({
        mode:                        "subscription",
        "line_items[0][price]":      priceId,
        "line_items[0][quantity]":   "1",
        success_url:                 successUrl,
        cancel_url:                  cancelUrl,
        "customer_email":            email || "",
        "subscription_data[metadata][vendor_name]": name || "",
      });

      // Add any extra metadata
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
        return res.end(JSON.stringify({ error: data.error?.message || "Checkout session failed" }));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: data.url, sessionId: data.id }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
