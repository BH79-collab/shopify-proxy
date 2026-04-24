const http  = require("http");
const https = require("https");

const PORT = process.env.PORT || 3001;
const HOST = "0.0.0.0";

http.createServer((req, res) => {

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Headers", "x-shopify-token, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  let u;
  try { u = new URL(req.url, "http://localhost"); }
  catch(e) { res.writeHead(400); return res.end(JSON.stringify({ error: "bad url" })); }

  if (u.pathname !== "/shopify") {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "use /shopify endpoint" }));
  }

  const store = u.searchParams.get("store");
  const path  = u.searchParams.get("path");
  const token = req.headers["x-shopify-token"];

  if (!store || !path || !token) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "missing store, path or token" }));
  }

  const clean  = store.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const target = new URL("https://" + clean + "/admin/api/2024-01/" + path);

  const options = {
    hostname: target.hostname,
    path:     target.pathname + target.search,
    method:   "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type":           "application/json",
      "Accept":                 "application/json",
    },
  };

  const r = https.request(options, (sr) => {
    let body = "";
    sr.on("data", c => body += c);
    sr.on("end",  () => {
      res.writeHead(sr.statusCode, {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    });
  });

  r.on("error", e => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });

  r.setTimeout(15000, () => {
    r.destroy();
    res.writeHead(504);
    res.end(JSON.stringify({ error: "timeout" }));
  });

  r.end();

}).listen(PORT, HOST, () => {
  console.log(`Proxy ready on http://${HOST}:${PORT}`);
});
