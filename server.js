// Ekstraklasa – serwer proxy do SportAPI7 (RapidAPI) + analiza AI (NVIDIA Nemotron).
// Klucze są tylko w zmiennych środowiskowych: RAPIDAPI_KEY, NVIDIA_API_KEY.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.RAPIDAPI_KEY;
const NV_KEY = process.env.NVIDIA_API_KEY;
const NV_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const HOST = "sportapi7.p.rapidapi.com";
const TOURNAMENT = 202; // PKO BP Ekstraklasa

// ---------- cache (oszczędza miesięczny limit zapytań) ----------
const cache = new Map();
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function callApi(apiPath, ttlMs = 120000) {
  const hit = cache.get(apiPath);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  try {
    const r = await fetch(`${process.env.SPORTAPI_BASE || `https://${HOST}`}${apiPath}`, {
      headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": HOST },
      signal: AbortSignal.timeout(25000),
    });
    const body = await r.text();
    let data;
    try { data = JSON.parse(body); } catch { data = { raw: body }; }
    const v = { status: r.status, data };
    if (r.ok) { cache.set(apiPath, { t: Date.now(), v }); return v; }
    if (hit) return hit.v; // błąd (np. 429) -> oddaj starsze dane, jeśli są
    if (r.status === 429) v.data = { error: "Limit zapytań SportAPI7 (plan BASIC) został wyczerpany. Spróbuj później." };
    return v;
  } catch (e) {
    if (hit) return hit.v;
    throw e;
  }
}
const must = (r) => {
  if (r.status !== 200) throw new HttpErr(r.status, r.data?.error || r.data?.message || `Błąd SportAPI7 (${r.status})`);
  return r.data;
};

async function seasonId() {
  const d = must(await callApi(`/api/v1/unique-tournament/${TOURNAMENT}/seasons`, 6 * 3600 * 1000));
  const s = d.seasons?.[0];
  if (!s) throw new Error("Nie udało się pobrać sezonu");
  return s.id;
}

// ---------- analiza AI ----------
const league = (e) => e.tournament?.uniqueTournament?.id === TOURNAMENT;
function formOf(events, id, n = 6) {
  return events
    .filter((e) => e.status?.type === "finished" && league(e))
    .sort((a, b) => b.startTimestamp - a.startTimestamp)
    .slice(0, n)
    .map((e) => {
      const home = e.homeTeam.id === id;
      const gf = home ? e.homeScore?.current : e.awayScore?.current;
      const ga = home ? e.awayScore?.current : e.homeScore?.current;
      return {
        eventId: e.id, date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10),
        opponent: home ? e.awayTeam.name : e.homeTeam.name, home, gf, ga,
        res: gf > ga ? "Z" : gf < ga ? "P" : "R",
        homeTeamId: e.homeTeam.id, awayTeamId: e.awayTeam.id,
      };
    });
}
const STAT_KEYS = ["matches", "goalsScored", "goalsConceded", "assists", "shots", "shotsOnTarget", "bigChancesCreated",
  "bigChancesMissed", "averageBallPossession", "accuratePassesPercentage", "cleanSheets", "corners", "fouls",
  "yellowCards", "redCards", "interceptions", "tackles", "duelsWonPercentage", "goalsFromInsideTheBox", "goalsFromOutsideTheBox"];
function pickStats(s) {
  const out = {};
  for (const k of STAT_KEYS) if (typeof s?.[k] === "number") out[k] = Math.round(s[k] * 100) / 100;
  if (!Object.keys(out).length) for (const [k, v] of Object.entries(s || {}).slice(0, 25)) if (typeof v === "number") out[k] = v;
  return out;
}

async function nvidia(messages) {
  if (!NV_KEY) throw new HttpErr(500, "Brak zmiennej środowiskowej NVIDIA_API_KEY");
  const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${NV_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: NV_MODEL, messages, max_tokens: 6000, temperature: 0.4, top_p: 0.95,
      chat_template_kwargs: { enable_thinking: true, medium_effort: true },
    }),
    signal: AbortSignal.timeout(150000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpErr(502, `Błąd NVIDIA API (${r.status}): ${d.detail || d.error?.message || d.message || ""}`);
  return d.choices?.[0]?.message?.content || "";
}
function parseJson(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

const analysisCache = new Map();
let analysisLog = []; // prosty limit: max 20 nowych analiz na godzinę (ochrona kluczy)

async function analysis(teamId) {
  const S = await seasonId();
  const tab = must(await callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${S}/standings/total`, 600000));
  const rows = tab.standings[0].rows;
  const row = rows.find((r) => r.team.id === teamId);
  if (!row) throw new HttpErr(404, "Nie znaleziono drużyny w tabeli Ekstraklasy");

  const lastEv = must(await callApi(`/api/v1/team/${teamId}/events/last/0`, 600000)).events || [];
  const nextEv = (must(await callApi(`/api/v1/team/${teamId}/events/next/0`, 600000)).events || [])
    .filter((e) => league(e) && e.status?.type === "notstarted")
    .sort((a, b) => a.startTimestamp - b.startTimestamp)[0];

  const key = `${teamId}:${nextEv?.id || 0}:${row.matches}`;
  const hit = analysisCache.get(key);
  if (hit && Date.now() - hit.t < 3 * 3600 * 1000) return hit.v;

  const now = Date.now();
  analysisLog = analysisLog.filter((t) => now - t < 3600 * 1000);
  if (analysisLog.length >= 20) throw new HttpErr(429, "Limit 20 analiz na godzinę został osiągnięty. Spróbuj później.");

  const stats = pickStats(must(await callApi(`/api/v1/team/${teamId}/unique-tournament/${TOURNAMENT}/season/${S}/statistics/overall`, 6 * 3600 * 1000)).statistics);
  const form = formOf(lastEv, teamId);

  let next = null, oppRow = null, oppForm = [];
  if (nextEv) {
    const home = nextEv.homeTeam.id === teamId;
    const opp = home ? nextEv.awayTeam : nextEv.homeTeam;
    oppRow = rows.find((r) => r.team.id === opp.id);
    const oppLast = must(await callApi(`/api/v1/team/${opp.id}/events/last/0`, 600000)).events || [];
    oppForm = formOf(oppLast, opp.id);
    next = { eventId: nextEv.id, home, opponent: opp.name, round: nextEv.roundInfo?.round, date: nextEv.startTimestamp };
  }

  const trow = (r) => r && { miejsce: r.position, mecze: r.matches, zwyciestwa: r.wins, remisy: r.draws, porazki: r.losses, bramki: `${r.scoresFor}:${r.scoresAgainst}`, punkty: r.points };
  const fmt = (f) => f.map((m) => `${m.date} ${m.home ? "(d)" : "(w)"} ${m.opponent} ${m.gf}:${m.ga} [${m.res}]`);
  const ctx = {
    druzyna: row.team.name, tabela: trow(row), forma_ostatnie_mecze: fmt(form), statystyki_sezonu: stats,
    nastepny_mecz: next && { przeciwnik: next.opponent, grasz: next.home ? "u siebie" : "na wyjeździe", kolejka: next.round },
    przeciwnik: next && { tabela: trow(oppRow), forma_ostatnie_mecze: fmt(oppForm) },
  };

  const system = "Jesteś analitykiem piłkarskim polskiej Ekstraklasy. Opierasz się WYŁĄCZNIE na dostarczonych danych " +
    "(nie wymyślaj kontuzji, transferów ani innych faktów, których tam nie ma). Piszesz po polsku, rzeczowo. " +
    "Zwracasz wyłącznie jeden obiekt JSON, bez komentarza i bez markdown.";
  const user = `Dane:\n${JSON.stringify(ctx, null, 1)}\n\nZwróć JSON o dokładnie takim schemacie:\n` +
    `{"podsumowanie_formy":"2-3 zdania o bieżącej formie","mocne_strony":["..","..",".."],"slabe_strony":["..","..",".."],` +
    `"kluczowe_czynniki":["..","..",".."],` +
    `"prognoza":${next ? `{"wygrana_gospodarzy":0,"remis":0,"wygrana_gosci":0,"typowany_wynik":"gospodarz:gość","pewnosc":"niska|średnia|wysoka","uzasadnienie":"2-3 zdania"}` : "null"}}\n` +
    (next ? `Procenty mają sumować się do 100. Typowany wynik podaj w kolejności gospodarz:gość (gospodarzem jest ${next.home ? row.team.name : next.opponent}).` : "Brak zaplanowanego meczu – ustaw prognozę na null.");

  analysisLog.push(now);
  const text = await nvidia([{ role: "system", content: system }, { role: "user", content: user }]);
  const parsed = parseJson(text);

  const v = {
    team: { id: teamId, name: row.team.name }, table: trow(row), form, next, stats,
    lastMatch: form[0] ? { id: form[0].eventId, homeTeamId: form[0].homeTeamId, awayTeamId: form[0].awayTeamId } : null,
    ai: parsed, raw: parsed ? undefined : text, model: NV_MODEL, generatedAt: Date.now(),
  };
  analysisCache.set(key, { t: Date.now(), v });
  return v;
}

// ---------- API-Football: opcja zastępcza ----------
// Darmowy plan: 100 zapytań/dzień, dane tylko z okna wczoraj–dziś–jutro (bez tabeli i sezonu 26/27).
const AF_KEY = process.env.API_FOOTBALL_KEY;
const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_STATUS = { NS: "notstarted", TBD: "notstarted", "1H": "inprogress", HT: "inprogress", "2H": "inprogress", ET: "inprogress",
  BT: "inprogress", P: "inprogress", LIVE: "inprogress", INT: "inprogress", SUSP: "inprogress", FT: "finished", AET: "finished", PEN: "finished" };
const AF_DESC = { NS: "Zaplanowany", TBD: "Do ustalenia", "1H": "1. połowa", HT: "Przerwa", "2H": "2. połowa", ET: "Dogrywka", P: "Rzuty karne",
  FT: "Zakończony", AET: "Po dogrywce", PEN: "Po rzutach karnych", PST: "Przełożony", CANC: "Odwołany", SUSP: "Przerwany", INT: "Przerwany", ABD: "Przerwany", LIVE: "Trwa" };

async function afCall(p, ttl = 120000) {
  if (!AF_KEY) throw new HttpErr(503, "Brak zmiennej środowiskowej API_FOOTBALL_KEY (opcja zastępcza wyłączona)");
  const ck = "AF:" + p, hit = cache.get(ck);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  try {
    const r = await fetch(AF_BASE + p, { headers: { "x-apisports-key": AF_KEY }, signal: AbortSignal.timeout(25000) });
    const d = await r.json().catch(() => ({}));
    const errs = d.errors && typeof d.errors === "object" ? Object.values(d.errors) : [];
    if (!r.ok || errs.length) {
      if (hit) return hit.v;
      const msg = d.errors?.plan || d.errors?.requests || d.errors?.rateLimit || errs[0] || `Błąd API-Football (${r.status})`;
      throw new HttpErr(r.ok ? 403 : r.status, `API-Football: ${msg}`);
    }
    cache.set(ck, { t: Date.now(), v: d.response });
    return d.response;
  } catch (e) {
    if (hit) return hit.v;
    throw e;
  }
}
const afEvent = (f) => ({
  id: `af-${f.fixture.id}`,
  homeTeam: { id: f.teams.home.id, name: f.teams.home.name }, awayTeam: { id: f.teams.away.id, name: f.teams.away.name },
  homeScore: { current: f.goals.home }, awayScore: { current: f.goals.away },
  startTimestamp: f.fixture.timestamp,
  status: { type: AF_STATUS[f.fixture.status.short] || "postponed", description: AF_DESC[f.fixture.status.short] || f.fixture.status.long },
  roundInfo: { round: parseInt((f.league?.round || "").match(/(\d+)\s*$/)?.[1], 10) || undefined },
  venue: { stadium: { name: f.fixture.venue?.name }, city: { name: f.fixture.venue?.city } },
  referee: f.fixture.referee ? { name: f.fixture.referee } : undefined,
  tournament: { name: "Ekstraklasa", category: { name: "Poland" } },
});
const afLeague = (list) => (list || []).filter((f) => f.league?.id === 106).map(afEvent);

async function afEventRoute(id, sub) {
  const fx = (await afCall(`/fixtures?id=${id}`, 120000))[0];
  if (!fx) throw new HttpErr(404, "Nie znaleziono meczu");
  const homeId = fx.teams.home.id;
  if (!sub) return { event: afEvent(fx) };
  if (sub === "incidents") {
    const ev = await afCall(`/fixtures/events?fixture=${id}`, 600000);
    return { incidents: ev.filter((x) => (x.type === "Goal" && x.detail !== "Missed Penalty") || x.type === "Card").map((x) => ({
      incidentType: x.type === "Goal" ? "goal" : "card",
      incidentClass: x.type === "Goal" ? (/Own/i.test(x.detail) ? "ownGoal" : /Penalty/i.test(x.detail) ? "penalty" : "regular") : (/Yellow/i.test(x.detail) && !/Red/i.test(x.detail) ? "yellow" : "red"),
      time: x.time.elapsed, isHome: x.team.id === homeId, player: { name: x.player?.name },
    })) };
  }
  if (sub === "stats") {
    const st = await afCall(`/fixtures/statistics?fixture=${id}`, 600000);
    const h = st.find((s) => s.team.id === homeId)?.statistics || [], a = st.find((s) => s.team.id !== homeId)?.statistics || [];
    const num = (v) => parseFloat(String(v ?? 0).replace("%", "")) || 0;
    const items = h.map((x) => { const y = a.find((z) => z.type === x.type);
      return { name: x.type, home: String(x.value ?? 0), away: String(y?.value ?? 0), homeValue: num(x.value), awayValue: num(y?.value) }; });
    return { statistics: [{ period: "ALL", groups: [{ groupName: "Statystyki", statisticsItems: items }] }] };
  }
  const lu = await afCall(`/fixtures/lineups?fixture=${id}`, 600000);
  const side = (t) => t && { formation: t.formation, players: [
    ...(t.startXI || []).map((x) => ({ player: { id: x.player.id, name: x.player.name }, shirtNumber: x.player.number, substitute: false })),
    ...(t.substitutes || []).map((x) => ({ player: { id: x.player.id, name: x.player.name }, shirtNumber: x.player.number, substitute: true })),
  ] };
  return { home: side(lu.find((t) => t.team.id === homeId)), away: side(lu.find((t) => t.team.id !== homeId)) };
}

// ---------- routing ----------
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function route(p) {
  let m;
  if (p === "/api/table") {
    const s = await seasonId();
    return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/standings/total`, 600000);
  }
  if (p === "/api/rounds") {
    const s = await seasonId();
    return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/rounds`, 1800000);
  }
  if ((m = p.match(/^\/api\/round\/(\d{1,2})$/))) {
    const s = await seasonId();
    return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/events/round/${m[1]}`, 300000);
  }
  if (p === "/api/live") {
    let r;
    try { r = await callApi(`/api/v1/sport/football/events/live`, 90000); } catch (e) { r = { status: 502, data: { error: String(e.message || e) } }; }
    if (r.status === 200) {
      return { status: 200, data: { source: "sportapi7", events: (r.data?.events || []).filter((e) => e.tournament?.uniqueTournament?.id === TOURNAMENT) } };
    }
    if (AF_KEY) {
      try { return { status: 200, data: { source: "api-football", events: afLeague(await afCall("/fixtures?live=all", 60000)) } }; } catch {}
    }
    return r;
  }
  if ((m = p.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/))) { // tylko API-Football (wczoraj–dziś–jutro)
    const list = await afCall(`/fixtures?date=${m[1]}&timezone=Europe/Warsaw`, 120000);
    return { status: 200, data: { source: "api-football", events: afLeague(list) } };
  }
  if ((m = p.match(/^\/api\/event\/(af-\d+|\d+)(?:\/(stats|lineups|incidents))?$/))) {
    if (m[1].startsWith("af-")) return { status: 200, data: await afEventRoute(m[1].slice(3), m[2]) };
    const sub = { stats: "/statistics", lineups: "/lineups", incidents: "/incidents" }[m[2]] || "";
    return callApi(`/api/v1/event/${m[1]}${sub}`, m[2] ? 3600000 : 120000);
  }
  if ((m = p.match(/^\/api\/heatmap\/(\d+)\/(\d+)$/))) {
    return callApi(`/api/v1/event/${m[1]}/player/${m[2]}/heatmap`, 3600000);
  }
  if ((m = p.match(/^\/api\/analysis\/(\d+)$/))) {
    return { status: 200, data: await analysis(Number(m[1])) };
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
      return send(res, e.status || 502, { error: String(e.message || e) });
    }
  }

  fs.readFile(path.join(__dirname, "index.html"), (err, buf) => {
    if (err) { res.writeHead(500); return res.end("Brak index.html"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Ekstraklasa działa na http://localhost:${PORT}`));
