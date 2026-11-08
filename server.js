// Ekstraklasa – serwer proxy do SportAPI7 (RapidAPI). Klucz API zostaje po stronie serwera.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.RAPIDAPI_KEY;
const HOST = "sportapi7.p.rapidapi.com";
const TOURNAMENT = 202; // PKO BP Ekstraklasa
const cache = new Map();

async function callApi(apiPath, ttlMs = 30000) {
  const hit = cache.get(apiPath);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
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

// Aktualny sezon wykrywany automatycznie (najnowszy na liście), cache 6 h.
async function seasonId() {
  const r = await callApi(`/api/v1/unique-tournament/${TOURNAMENT}/seasons`, 6 * 3600 * 1000);
  const s = r.data?.seasons?.[0];
  if (!s) throw new Error("Nie udało się pobrać sezonu");
  return s.id;
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function route(p) {
  let m;
  if (p === "/api/table") {
    const s = await seasonId();
    return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/standings/total`, 120000);
  }
  if (p === "/api/rounds") {
    const s = await seasonId();
    return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/rounds`, 600000);
  }
  if ((m = p.match(/^\/api\/round\/(\d{1,2})$/))) {
    const s = await seasonId();
    return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/events/round/${m[1]}`, 30000);
  }
  if (p === "/api/live") {
    const r = await callApi(`/api/v1/sport/football/events/live`, 20000);
    const events = (r.data?.events || []).filter((e) => e.tournament?.uniqueTournament?.id === TOURNAMENT);
    return { status: r.status, data: { events } };
  }
  if ((m = p.match(/^\/api\/event\/(\d+)(?:\/(stats|lineups|incidents))?$/))) {
    const sub = { stats: "/statistics", lineups: "/lineups", incidents: "/incidents" }[m[2]] || "";
    return callApi(`/api/v1/event/${m[1]}${sub}`, m[2] ? 30000 : 20000);
  }
  return { status: 404, data: { error: "Nieznany endpoint" } };
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (p.startsWith("/api/")) {
    if (!KEY) return send(res, 500, { error: "Brak zmiennej środowiskowej RAPIDAPI_KEY" });
    try {
      const r = await route(p);
      return send(res, r.status, r.data);
    } catch (e) {
      return send(res, 502, { error: String(e.message || e) });
    }
  }

  fs.readFile(path.join(__dirname, "index.html"), (err, buf) => {
    if (err) { res.writeHead(500); return res.end("Brak index.html"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Ekstraklasa działa na http://localhost:${PORT}`));
