// Serwer proxy do SportAPI7 (RapidAPI). Klucz API zostaje po stronie serwera.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.RAPIDAPI_KEY;
const HOST = "sportapi7.p.rapidapi.com";
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

async function callApi(apiPath) {
  const hit = cache.get(apiPath);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  const r = await fetch(`https://${HOST}${apiPath}`, {
    headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": HOST },
  });
  const body = await r.text();
  let data;
  try { data = JSON.parse(body); } catch { data = { raw: body }; }
  const v = { status: r.status, data };
  if (r.ok) cache.set(apiPath, { t: Date.now(), v });
  return v;
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p.startsWith("/api/")) {
    if (!KEY) return send(res, 500, { error: "Brak zmiennej środowiskowej RAPIDAPI_KEY" });
    try {
      let m;
      if ((m = p.match(/^\/api\/event\/(\d+)$/))) {
        const r = await callApi(`/api/v1/event/${m[1]}`);
        return send(res, r.status, r.data);
      }
      if ((m = p.match(/^\/api\/scheduled\/([a-z-]+)\/(\d{4}-\d{2}-\d{2})$/))) {
        const r = await callApi(`/api/v1/sport/${m[1]}/scheduled-events/${m[2]}`);
        return send(res, r.status, r.data);
      }
      if ((m = p.match(/^\/api\/live\/([a-z-]+)$/))) {
        const r = await callApi(`/api/v1/sport/${m[1]}/events/live`);
        return send(res, r.status, r.data);
      }
      return send(res, 404, { error: "Nieznany endpoint" });
    } catch (e) {
      return send(res, 502, { error: String(e) });
    }
  }

  const file = path.join(__dirname, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(500); return res.end("Brak index.html"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Działa na http://localhost:${PORT}`));
