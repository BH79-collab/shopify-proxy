// proxy.js — Shopify proxy for Merch on Demand
// Requirements: Node.js 18+  (nodejs.org — free, click LTS)
// Run with:     node proxy.js

const http  = require("http");
const https = require("https");

http.createServer((req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "x-shopify-token, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const u     = new URL(req.url, "http://localhost");
  const store = u.searchParams.get("store");
  const path  = u.searchParams.get("path");
  const token = req.headers["x-shopify-token"];

  if (u.pathname !== "/shopify" || !store || !path || !token) {
    res.writeHead(400);
    return res.end("Bad request");
  }

  const target = new URL(
    "https://" + store + "/admin/api/2024-01/" + path
  );

  const options = {
    hostname: target.hostname,
    path:     target.pathname + target.search,
    headers:  {
      "X-Shopify-Access-Token": token,
      "Content-Type":           "application/json",
    },
  };

  https.get(options, (shopRes) => {
    let body = "";
    shopRes.on("data",  chunk => body += chunk);
    shopRes.on("end",   ()    => {
      res.writeHead(shopRes.statusCode, {
        "Content-Type": "application/json",
      });
      res.end(body);
    });
  }).on("error", (err) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });

}).listen(3001, () => {
  console.log("Proxy ready → http://localhost:3001");
});