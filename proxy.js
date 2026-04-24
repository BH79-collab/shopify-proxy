const http  = require("http");
const https = require("https");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "x-shopify-token, Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

http.createServer((req, res) => {

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "Invalid URL" }));
  }

  if (u.pathname !== "/shopify") {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "Bad request — use /shopify endpoint" }));
  }

  const store = u.searchParams.get("store");
  const path  = u.searchParams.get("path");
  const token = req.headers["x-shopify-token"];

  if (!store || !path || !token) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "Missing store, path or x-shopify-token header" }));
  }

  const cleanStore = store.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  let target;
  try {
    target = new URL("https://" + cleanStore + "/admin/api/2024-01/" + path);
  } catch {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "Invalid store URL: " + cleanStore }));
  }

  const options = {
    hostname: target.hostname,
    path:     target.pathname + target.search,
    method:   "GET",
    headers:  {
      "X-Shopify-Access-Token": token,
      "Content-Type":           "application/json",
      "Accept":                 "application/json",
    },
  };

  const shopReq = https.request(options, (shopRes) => {
    let body = "";
    shopRes.on("data",  chunk => { body += chunk; });
    shopRes.on("end",   () => {
      res.writeHead(shopRes.statusCode, {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    });
  });

  shopReq.on("error", (err) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: "Shopify request failed: " + err.message }));
  });

  shopReq.setTimeout(10000, () => {
    shopReq.destroy();
    res.writeHead(504);
    res.end(JSON.stringify({ error: "Shopify request timed out" }));
  });

  shopReq.end();

}).listen(process.env.PORT || 3001, () => {
  console.log("Proxy ready on port " + (process.env.PORT || 3001));
});
