// Ekstraklasa – serwer proxy: Flashscore API (główne), SportAPI7 i API-Football (zapasowe) + analiza AI (NVIDIA Nemotron).
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

// ---------- Flashscore API (RapidAPI) – główne źródło ----------
// Plan darmowy: 30 zapytań na DOBĘ, więc: długi cache, dane sezonu (wyniki + terminarz = 4 zapytania) służą do
// policzenia kolejek, tabeli i formy bez dodatkowych zapytań, a w razie braku limitu używany jest zapis z fs-seed.json.
const FS_HOST = "flashscore-api1.p.rapidapi.com";
const FS_BASE = process.env.FS_BASE || `https://${FS_HOST}/api/flashscore/v2`;
const FS_URL = "/football/poland/ekstraklasa/";
const HOUR = 3600 * 1000;
let SEED = null;
try { SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fs-seed.json"), "utf8")); } catch {}
let fsLeft = null, fsResetAt = 0;
const inflight = new Map();
const FS_LIMIT_MSG = "Dzienny limit Flashscore API (30 zapytań) został wyczerpany – odnowi się w ciągu doby.";

function fsCall(p, ttl = 2 * HOUR) {
  const ck = "FS:" + p, hit = cache.get(ck);
  if (hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.v);
  if (inflight.has(ck)) return inflight.get(ck);
  const job = (async () => {
    if (fsLeft !== null && fsLeft <= 0 && Date.now() < fsResetAt) {
      if (hit) return hit.v;
      throw new HttpErr(429, FS_LIMIT_MSG);
    }
    try {
      const r = await fetch(FS_BASE + p, { headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": FS_HOST }, signal: AbortSignal.timeout(25000) });
      const left = r.headers.get("x-ratelimit-requests-remaining"), reset = r.headers.get("x-ratelimit-requests-reset");
      if (left !== null) { fsLeft = Number(left); fsResetAt = Date.now() + (Number(reset) || 3600) * 1000; }
      if (r.status === 429) { fsLeft = 0; fsResetAt = Date.now() + (Number(reset) || 1800) * 1000; }
      const d = await r.json().catch(() => null);
      if (!r.ok || d === null || d?.error === true) {
        if (hit) return hit.v;
        if (r.status === 429) throw new HttpErr(429, FS_LIMIT_MSG);
        throw new HttpErr(r.ok ? 502 : r.status, `Flashscore API: ${d?.message || r.status}`);
      }
      cache.set(ck, { t: Date.now(), v: d });
      return d;
    } catch (e) {
      if (hit) return hit.v;
      throw e;
    }
  })().finally(() => inflight.delete(ck));
  inflight.set(ck, job);
  return job;
}

const roundNo = (s) => parseInt(String(s || "").match(/\d+/)?.[0], 10) || null;
const fsStatus = (ms) => (ms?.is_cancelled || ms?.is_postponed ? "postponed" : ms?.is_finished ? "finished" : ms?.is_in_progress ? "inprogress" : "notstarted");
const fsTeam = (t) => ({ team_id: t.team_id, name: t.name, short_name: t.short_name });
function slimFs(m, round) {
  const ms = m.match_status || {}, sc = m.scores || {};
  return {
    match_id: m.match_id, round: m.round || round || null, timestamp: m.start_timestamp ?? m.timestamp,
    home_team: fsTeam(m.home_team), away_team: fsTeam(m.away_team), status: fsStatus(ms),
    home: sc.home ?? null, away: sc.away ?? null,
    live: ms.live_minute != null ? `${ms.live_minute}'` : ms.live_time || null,
  };
}
function mergeMatches(...lists) {
  const m = new Map();
  for (const l of lists) for (const x of l) { const o = m.get(x.match_id); if (!(o && o.status === "finished" && x.status !== "finished")) m.set(x.match_id, x); }
  return [...m.values()];
}
async function fsIds() {
  try {
    const d = await fsCall(`/tournaments/ids?tournament_url=${encodeURIComponent(FS_URL)}`, 7 * 24 * HOUR);
    if (!d?.tournament_template_id) throw new Error("brak ID turnieju");
    return { season_id: d.season_id, tournament_id: d.tournament_id, tournament_stage_id: d.tournament_stage_id, tournament_template_id: d.tournament_template_id };
  } catch (e) { if (SEED) return SEED.ids; throw e; }
}
async function fsPages(kind, ids, ttl) {
  const out = [];
  for (let pg = 1; pg <= 5; pg++) {
    const d = await fsCall(`/tournaments/${kind}?tournament_template_id=${ids.tournament_template_id}&season_id=${ids.season_id}&page=${pg}&language=pl`, ttl);
    if (!Array.isArray(d)) throw new HttpErr(502, "Flashscore API: nieoczekiwana odpowiedź");
    out.push(...d);
    if (d.length < 100) break; // strona ma ~105-110 pozycji; krótsza = ostatnia
  }
  return out;
}
let seasonMem = null;
async function fsSeason() {
  try {
    const ids = await fsIds();
    const results = (await fsPages("results", ids, 2 * HOUR)).map((m) => slimFs(m));
    const fixtures = (await fsPages("fixtures", ids, 6 * HOUR)).map((m) => slimFs(m));
    seasonMem = { ids, matches: mergeMatches(fixtures, results), stale: false, at: Date.now() };
    return seasonMem;
  } catch (e) {
    if (seasonMem) return { ...seasonMem, stale: true, why: e.message };
    if (SEED) return { ids: SEED.ids, matches: mergeMatches(SEED.fixtures, SEED.results), stale: true, seed: true, why: e.message };
    throw e;
  }
}
const seasonNote = (s) => {
  if (!s.stale) return undefined;
  const why = String(s.why || "Flashscore API chwilowo niedostępne").replace(/\.$/, "");
  return s.seed ? `Dane z zapisu z ${SEED?.savedAt} – ${why}. Odświeżą się, gdy wróci limit zapytań.` : `Dane z pamięci podręcznej – ${why}.`;
};

const pfxOf = (x) => (x.src === "tm" ? "tm-" : "fs-");
const fsDesc = (x) => (x.status === "finished" ? "Zakończony" : x.status === "notstarted" ? "Zaplanowany" : x.status === "postponed" ? "Przełożony" : x.live || "Trwa");
const fsEv = (x) => ({
  id: pfxOf(x) + x.match_id,
  homeTeam: { id: pfxOf(x) + x.home_team.team_id, name: x.home_team.name }, awayTeam: { id: pfxOf(x) + x.away_team.team_id, name: x.away_team.name },
  homeScore: { current: x.home }, awayScore: { current: x.away }, startTimestamp: x.timestamp,
  status: { type: x.status, description: fsDesc(x) }, roundInfo: { round: roundNo(x.round) },
  tournament: { name: "Ekstraklasa", category: { name: "Polska" } },
});

function tableFrom(matches) {
  const P = matches[0] ? pfxOf(matches[0]) : "fs-", t = new Map();
  const get = (tm) => { if (!t.has(tm.team_id)) t.set(tm.team_id, { id: tm.team_id, name: tm.name, n: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }); return t.get(tm.team_id); };
  for (const m of matches) { get(m.home_team); get(m.away_team); }
  for (const m of matches) {
    if (m.status !== "finished" || m.home == null || m.away == null) continue;
    const h = get(m.home_team), a = get(m.away_team);
    h.n++; a.n++; h.gf += m.home; h.ga += m.away; a.gf += m.away; a.ga += m.home;
    if (m.home > m.away) { h.w++; h.pts += 3; a.l++; } else if (m.home < m.away) { a.w++; a.pts += 3; h.l++; } else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  return [...t.values()]
    .sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.name.localeCompare(y.name, "pl"))
    .map((r, i) => ({ position: i + 1, team: { id: P + r.id, name: r.name }, matches: r.n, wins: r.w, draws: r.d, losses: r.l, scoresFor: r.gf, scoresAgainst: r.ga, points: r.pts }));
}
async function fsTable(season) {
  if (!season.seed || !season.stale) {
    try {
      const d = await fsCall(`/tournaments/standings?tournament_id=${season.ids.tournament_id}&tournament_stage_id=${season.ids.tournament_stage_id}&language=pl`, 2 * HOUR);
      if (Array.isArray(d) && d.length) {
        return d.map((r) => { const [gf, ga] = String(r.goals || "0:0").split(":").map(Number);
          return { position: r.rank, team: { id: "fs-" + r.team_id, name: r.name }, matches: r.matches_played, wins: r.wins, draws: r.draws, losses: r.losses, scoresFor: gf, scoresAgainst: ga, points: r.points }; })
          .sort((a, b) => a.position - b.position);
      }
    } catch {}
  }
  return tableFrom(season.matches); // zapas: tabela policzona z wyników sezonu (0 zapytań)
}
function fsRounds(matches) {
  const max = Math.max(34, ...matches.map((m) => roundNo(m.round) || 0));
  const fin = matches.filter((m) => m.status === "finished").map((m) => roundNo(m.round) || 0);
  const last = fin.length ? Math.max(...fin) : 0, now = Date.now() / 1000;
  // bieżąca kolejka = kolejka najbliższego nierozegranego meczu (pomijamy zaległe mecze z wcześniejszych kolejek)
  const nxt = matches.filter((m) => m.status !== "finished" && m.status !== "postponed" && m.timestamp >= now - 4 * 3600 && (roundNo(m.round) || 0) >= last)
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  return { currentRound: { round: Math.min(max, nxt ? roundNo(nxt.round) || last : Math.max(1, last)) }, rounds: Array.from({ length: max }, (_, i) => ({ round: i + 1 })) };
}
async function fsLive(season) {
  const now = Date.now() / 1000;
  // pytamy API o mecze na żywo tylko wtedy, gdy według terminarza coś może się właśnie grać (oszczędność limitu)
  const maybe = season.matches.some((m) => m.status !== "finished" && m.status !== "postponed" && m.timestamp - 900 <= now && now <= m.timestamp + 4 * 3600);
  if (!maybe) return [];
  const d = await fsCall(`/matches/live?sport_id=1&language=pl`, 90000);
  const group = (Array.isArray(d) ? d : []).find((g) => g.tournament_stage_id === season.ids.tournament_stage_id || g.tournament_url === FS_URL);
  const byId = new Map(season.matches.map((m) => [m.match_id, m]));
  return (group?.matches || []).map((m) => fsEv(slimFs(m, byId.get(m.match_id)?.round)));
}

const fsTtl = async (id, finishedTtl = 24 * HOUR, liveTtl = 3 * 60000) => {
  const x = (await fsSeason()).matches.find((m) => m.match_id === id);
  return x?.status === "finished" ? finishedTtl : liveTtl;
};
async function fsEventRoute(id, sub) {
  const q = `match_id=${encodeURIComponent(id)}&language=pl`;
  if (!sub) {
    const x = (await fsSeason()).matches.find((m) => m.match_id === id);
    const now = Date.now() / 1000;
    const inWindow = x && x.status !== "finished" && x.status !== "postponed" && x.timestamp - 900 <= now && now <= x.timestamp + 4 * 3600;
    if (x && !inWindow) return { event: fsEv(x) };
    const d = await fsCall(`/matches/details?${q}`, inWindow ? 60000 : 6 * HOUR); // trwający mecz: świeży wynik + stadion, sędzia
    const ev = fsEv(slimFs(d, x?.round || d.tournament?.name));
    ev.venue = { stadium: { name: d.venue?.name }, city: { name: d.venue?.city } };
    if (d.referee) ev.referee = { name: d.referee };
    return { event: ev };
  }
  const ttl = await fsTtl(id);
  if (sub === "incidents") {
    const list = await fsCall(`/matches/match/summary?${q}`, ttl);
    const out = [];
    for (const it of Array.isArray(list) ? list : []) {
      const isHome = it.team === "home", time = parseInt(it.minutes, 10) || 0;
      for (const p of it.players || []) {
        const t = `${p.type || ""} ${p.sub_type || ""} ${it.description || ""}`;
        if (/assist|substitution/i.test(p.type || "")) continue;
        if (/goal/i.test(p.type || "") && !/disallow|cancel|missed/i.test(t))
          out.push({ incidentType: "goal", incidentClass: /own/i.test(t) ? "ownGoal" : /pen/i.test(t) ? "penalty" : "regular", time, isHome, player: { name: p.name } });
        else if (/card/i.test(p.type || ""))
          out.push({ incidentType: "card", incidentClass: /red/i.test(t) ? "red" : "yellow", time, isHome, player: { name: p.name } });
      }
    }
    return { incidents: out };
  }
  if (sub === "stats") {
    const st = await fsCall(`/matches/match/stats?${q}`, ttl), seen = new Set();
    const num = (v) => parseFloat(String(v ?? 0).replace("%", "")) || 0;
    const items = (st?.match || []).filter((x) => !seen.has(x.name) && seen.add(x.name))
      .map((x) => ({ name: x.name, home: String(x.home_team ?? 0), away: String(x.away_team ?? 0), homeValue: num(x.home_team), awayValue: num(x.away_team) }));
    return { statistics: [{ period: "ALL", groups: [{ groupName: "Statystyki", statisticsItems: items }] }] };
  }
  const lu = await fsCall(`/matches/match/lineups?${q}`, ttl);
  const side = (s) => { const t = (Array.isArray(lu) ? lu : []).find((x) => x.side === s); if (!t) return undefined;
    const pl = (a, sub) => (a || []).map((p) => ({ player: { id: p.player_id, name: p.name }, shirtNumber: p.number, substitute: sub }));
    return { formation: t.formation, players: [...pl(t.startingLineups, false), ...pl(t.substitutes, true)] }; };
  return { home: side("home"), away: side("away") };
}

// ---------- Transfermarkt (oficjalne JSON API strony, bez klucza i bez dziennego limitu) ----------
// Źródło główne dla tabeli, kolejek, meczów na żywo i składów (pomysł: github.com/felipeall/transfermarkt-api).
// API nieudokumentowane i może blokować część adresów IP – wtedy serwer przechodzi na Flashscore.
const TM_BASE = process.env.TM_BASE || "https://tmapi.transfermarkt.technology";
const TM_COMP = "PL1";
// nazwy klubów z polskimi znakami (Transfermarkt zwraca część bez diakrytyków)
const TM_NAMES = { 238: "Lech Poznań", 428: "Górnik Zabrze", 255: "Legia Warszawa", 324: "Pogoń Szczecin", 168: "Zagłębie Lubin", 2118: "Wisła Płock", 2300: "Jagiellonia Białystok",
  30974: "Wieczysta Kraków", 3527: "Motor Lublin", 422: "Wisła Kraków", 5689: "Cracovia", 6110: "Korona Kielce", 6112: "Piast Gliwice", 6456: "GKS Katowice",
  7154: "Radomiak Radom", 759: "Śląsk Wrocław", 88: "Widzew Łódź", 9644: "Raków Częstochowa" };
const tmName = (id, fallback) => TM_NAMES[id] || fallback || String(id);
let tmFailUntil = 0;
function tmCall(p, ttl = 10 * 60000) {
  const ck = "TM:" + p, hit = cache.get(ck);
  if (hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.v);
  if (inflight.has(ck)) return inflight.get(ck);
  const job = (async () => {
    try {
      const r = await fetch(TM_BASE + p, { headers: { Accept: "application/json", "User-Agent": "transfermarkt-api" }, signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      if (r.headers.get("x-amzn-waf-action") || (r.status === 202 && !text)) throw new HttpErr(503, "Transfermarkt zablokował zapytanie (WAF)");
      if (r.status === 403 || r.status === 429) throw new HttpErr(503, `Transfermarkt odmówił zapytania (${r.status})`);
      if (!r.ok) throw new HttpErr(r.status === 404 ? 404 : 502, `Transfermarkt: błąd ${r.status}`);
      let body; try { body = JSON.parse(text); } catch { throw new HttpErr(502, "Transfermarkt: nieprawidłowa odpowiedź"); }
      if (!body?.success || !("data" in body)) throw new HttpErr(502, "Transfermarkt: nieoczekiwana odpowiedź");
      cache.set(ck, { t: Date.now(), v: body.data });
      return body.data;
    } catch (e) {
      if (hit) return hit.v;
      throw e;
    }
  })().finally(() => inflight.delete(ck));
  inflight.set(ck, job);
  return job;
}
const ids100 = (ids) => ids.map((i) => `ids[]=${encodeURIComponent(i)}`).join("&");
async function tmEntities(route, ids) { // /clubs, /players (partiami po 100)
  const u = [...new Set(ids.filter(Boolean).map(String))].sort(), out = {};
  for (let i = 0; i < u.length; i += 100) for (const e of (await tmCall(`${route}?${ids100(u.slice(i, i + 100))}`, 7 * 24 * HOUR)) || []) out[String(e.id)] = e;
  return out;
}
const inWindow = (m, now = Date.now() / 1000) => m.status !== "finished" && m.status !== "postponed" && m.timestamp - 900 <= now && now <= m.timestamp + 4 * 3600;
let tmMem = null;
function estMinute(ts) { // Transfermarkt nie podaje minuty – szacujemy z godziny startu (1. połowa ~45', przerwa ~15', 2. połowa)
  const e = (Date.now() / 1000 - ts) / 60;
  if (!(e >= 0)) return null;
  if (e <= 47) return `~${Math.max(1, Math.floor(e))}'`;
  if (e <= 62) return "przerwa";
  const m = Math.floor(e - 15);
  return m > 90 ? "~90+'" : `~${m}'`;
}
async function tmSeason() {
  if (Date.now() < tmFailUntil && tmMem) return { ...tmMem, stale: true, why: "Transfermarkt chwilowo niedostępny" };
  if (Date.now() < tmFailUntil) throw new HttpErr(503, "Transfermarkt chwilowo niedostępny");
  try {
    const live = tmMem?.matches.some((m) => inWindow(m));
    const fx = await tmCall(`/competition/${TM_COMP}/fixtures`, live ? 90000 : 30 * 60000);
    const games = (fx?.fixtures || []).flatMap((d) => d.games || []);
    if (!games.length) throw new HttpErr(502, "Transfermarkt: pusty terminarz");
    const clubs = await tmEntities("/clubs", games.flatMap((g) => [g.homeClub?.clubId, g.awayClub?.clubId]));
    const nm = (id) => ({ team_id: String(id), name: tmName(id, clubs[id]?.name), short_name: clubs[id]?.baseDetails?.abbreviation });
    const matches = games.map((g) => ({
      src: "tm", match_id: g.gameId, round: `Kolejka ${g.baseDetails?.gameDay}`,
      timestamp: Math.floor(Date.parse(g.baseDetails?.date?.dateTimeUTC) / 1000) || 0,
      home_team: nm(g.homeClub.clubId), away_team: nm(g.awayClub.clubId),
      status: g.isFinished ? "finished" : g.isLive ? "inprogress" : "notstarted",
      home: g.score?.home ?? null, away: g.score?.away ?? null, live: g.isLive && !g.isFinished ? estMinute(Math.floor(Date.parse(g.baseDetails?.date?.dateTimeUTC) / 1000)) : null,
    }));
    tmMem = { tm: true, matches, stale: false, at: Date.now() };
    return tmMem;
  } catch (e) {
    tmFailUntil = Date.now() + 10 * 60000;
    throw e;
  }
}
async function tmTable(season) {
  try {
    const d = await tmCall(`/competition/${TM_COMP}/table`, season.matches.some((m) => inWindow(m)) ? 5 * 60000 : 30 * 60000);
    const names = new Map(season.matches.flatMap((m) => [[m.home_team.team_id, m.home_team.name], [m.away_team.team_id, m.away_team.name]]));
    const clubs = d?.tables?.[0]?.clubs || [];
    if (clubs.length) return clubs.map((c) => ({ position: c.ranking.current, team: { id: "tm-" + c.clubId, name: names.get(String(c.clubId)) || String(c.clubId) },
      matches: c.game.totalCount, wins: c.game.winCount, draws: c.game.drawCount, losses: c.game.lossCount, scoresFor: c.goal.totalCount, scoresAgainst: c.goal.concededCount, points: c.game.points }))
      .sort((a, b) => a.position - b.position);
  } catch {}
  return tableFrom(season.matches);
}
async function anySeason() { // Transfermarkt -> Flashscore (-> zapis)
  try { return await tmSeason(); } catch {}
  return fsSeason();
}
const seasonTable = (s) => (s.tm ? tmTable(s) : fsTable(s));

const tmMoney = (v) => v?.compact ? `${v.compact.prefix}${Number(v.compact.content)}${v.compact.suffix}` : "";
async function tmEventRoute(id, sub) {
  const season = await tmSeason();
  const x = season.matches.find((m) => m.match_id === id);
  const ttl = x?.status === "finished" ? 7 * 24 * HOUR : 60000;
  const d = await tmCall(`/game/${encodeURIComponent(id)}`, ttl);
  if (!sub) {
    const ev = fsEv(x || { src: "tm", match_id: id, round: `Kolejka ${d.baseDetails?.gameDay}`, timestamp: Math.floor(Date.parse(d.baseDetails?.date?.dateTimeUTC) / 1000),
      home_team: { team_id: d.homeClub.clubId, name: d.homeClub.clubId }, away_team: { team_id: d.awayClub.clubId, name: d.awayClub.clubId },
      status: "notstarted", home: d.score?.home ?? null, away: d.score?.away ?? null });
    ev.venue = { stadium: { name: d.stadium?.name }, city: { name: d.stadium?.location?.city } };
    return { event: ev };
  }
  const home = String(d.homeClub?.clubId);
  if (sub === "incidents") {
    const pl = await tmEntities("/players", (d.actions || []).map((a) => a.activePlayerId));
    return { incidents: (d.actions || []).filter((a) => a.type === "GOAL" || a.type === "CARD").map((a) => ({
      incidentType: a.type === "GOAL" ? "goal" : "card",
      incidentClass: a.type === "GOAL" ? (a.actionId === 206 ? "ownGoal" : a.actionId === 204 || a.actionId === 205 ? "penalty" : "regular") : a.actionId === 301 ? "yellow" : a.actionId === 302 ? "yellowRed" : "red",
      time: a.minute, isHome: String(a.clubId) === home, player: { name: pl[a.activePlayerId]?.name || "" } })) };
  }
  if (sub === "stats") {
    const h = d.homeClub?.clubStatistics, a = d.awayClub?.clubStatistics;
    if (!h || !a) return { statistics: [] };
    const rows = [["Posiadanie piłki", (c) => c.gameStatistics?.possessionPercentage, "%"], ["Strzały", (c) => c.goalStatistics?.totalShotAttempts],
      ["Strzały celne", (c) => c.goalStatistics?.onTargetShotAttempts], ["Strzały niecelne", (c) => c.goalStatistics?.offTargetShotAttempts],
      ["Strzały zablokowane", (c) => c.goalStatistics?.blockedShotAttempts], ["Rzuty rożne", (c) => c.setPieceStatistics?.cornersTaken],
      ["Podania celne", (c) => c.passingStatistics?.accuratePasses], ["Faule", (c) => c.penaltyStatistics?.freeKicksConcededFromFouls],
      ["Spalone", (c) => c.defensiveStatistics?.offsides], ["Obrony bramkarza", (c) => c.defensiveStatistics?.saves],
      ["Żółte kartki", (c) => c.gameStatistics?.yellowCards], ["Czerwone kartki", (c) => c.gameStatistics?.redCards]];
    const items = rows.map(([name, f, suf]) => ({ name, hv: f(h), av: f(a), suf: suf || "" })).filter((r) => r.hv != null && r.av != null)
      .map((r) => ({ name: r.name, home: `${r.hv}${r.suf}`, away: `${r.av}${r.suf}`, homeValue: Number(r.hv) || 0, awayValue: Number(r.av) || 0 }));
    return { statistics: [{ period: "ALL", groups: [{ groupName: "Statystyki", statisticsItems: items }] }] };
  }
  const all = [d.homeClub, d.awayClub].flatMap((c) => [...(c?.lineup?.players || []), ...(c?.lineup?.substitutes || [])]).map((p) => p.id);
  const pl = all.length ? await tmEntities("/players", all) : {};
  const side = (c) => c?.lineup?.players?.length && { formation: c.tactic?.tactic, players: [
    ...c.lineup.players.map((p) => ({ player: { id: p.id, name: pl[p.id]?.name || p.id }, shirtNumber: p.shirtNumber, substitute: false })),
    ...(c.lineup.substitutes || []).map((p) => ({ player: { id: p.id, name: pl[p.id]?.name || p.id }, shirtNumber: p.shirtNumber, substitute: true })) ] };
  return { home: side(d.homeClub) || undefined, away: side(d.awayClub) || undefined };
}

// ---------- Transfermarkt: dane drużyny (skład, wartości, kontuzje, strzelcy) ----------
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}
const POS_PL = { GOALKEEPER: "Bramkarze", DEFENDER: "Obrońcy", MIDFIELDER: "Pomocnicy", ATTACK: "Napastnicy", FORWARD: "Napastnicy" };
const REASON_PL = [[/yellow card suspension/i, "zawieszenie za kartki"], [/red card suspension/i, "zawieszenie za czerwoną kartkę"], [/cruciate ligament/i, "zerwane więzadła krzyżowe"],
  [/groin/i, "uraz pachwiny"], [/ankle/i, "uraz kostki"], [/knee/i, "uraz kolana"], [/hamstring/i, "uraz mięśnia dwugłowego"], [/muscle|muscular/i, "uraz mięśniowy"],
  [/thigh/i, "uraz uda"], [/calf/i, "uraz łydki"], [/foot/i, "uraz stopy"], [/back/i, "uraz pleców"], [/shoulder/i, "uraz barku"], [/ill|virus|flu|pneumonia/i, "choroba"],
  [/fracture|broken/i, "złamanie"], [/surgery|operation/i, "po operacji"], [/injur/i, "kontuzja"]];
const plReason = (n) => REASON_PL.find(([re]) => re.test(String(n || "")))?.[1] || String(n || "kontuzja");
const todayIso = () => new Date().toISOString().slice(0, 10);
const teamMemo = new Map();
function tmTeam(clubId, season) {
  const hit = teamMemo.get(clubId);
  if (hit?.v && Date.now() - hit.t < 3 * HOUR) return Promise.resolve(hit.v);
  if (hit?.p) return hit.p; // trwa już liczenie
  const p = (async () => {
    const [club, stadium, coachRec, squadRec] = await Promise.all([
      tmCall(`/club/${clubId}`, 24 * HOUR), tmCall(`/club/${clubId}/stadium`, 24 * HOUR).catch(() => null),
      tmCall(`/club/${clubId}/coach`, 24 * HOUR).catch(() => null), tmCall(`/club/${clubId}/squad`, 12 * HOUR)]);
    const members = (squadRec?.squad || []).filter((m) => m.type === "current" || !m.type);
    const [pl, coaches] = await Promise.all([tmEntities("/players", members.map((m) => m.playerId)),
      coachRec?.coachId ? tmEntities("/coaches", [coachRec.coachId]).catch(() => ({})) : {}]);
    const squad = members.map((m) => {
      const p = pl[m.playerId] || {}, mv = p.marketValueDetails?.current;
      return { id: String(m.playerId), name: p.name || String(m.playerId), shirt: m.shirtNumber, captain: !!m.isCaptain,
        position: POS_PL[p.attributes?.positionGroup] || "Inni", detail: p.attributes?.position?.name || "", age: p.lifeDates?.age ?? null,
        contract: p.attributes?.contractUntil || null, value: mv?.value ?? mv?.amount ?? null };
    }).sort((a, b) => (b.value || 0) - (a.value || 0));
    // niedostępni: sprawdzamy 22 najcenniejszych zawodników (kontuzje + zawieszenia), wynik w cache na 4 h
    const today = todayIso(), tops = squad.slice(0, 22);
    const unavailable = (await pool(tops, 6, async (pl1) => {
      const [inj, abs] = await Promise.all([tmCall(`/player/${pl1.id}/injury`, 4 * HOUR).catch(() => null), tmCall(`/player/${pl1.id}/absence`, 4 * HOUR).catch(() => null)]);
      const out = [];
      for (const x of inj?.injuries || []) if (!x.end || x.end >= today) out.push({ name: pl1.name, type: "kontuzja", reason: plReason(x.name), until: x.end || null });
      for (const x of abs?.absences || []) if (x.seasonId >= 2026 && x.end && x.end >= today) out.push({ name: pl1.name, type: "zawieszenie", reason: plReason(x.name), until: x.end });
      return out.slice(0, 2);
    })).flat().filter(Boolean);
    // strzelcy i asystenci z rozegranych meczów ligowych (mecz z cache 24 h)
    const games = season.matches.filter((m) => m.status === "finished" && (m.home_team.team_id === String(clubId) || m.away_team.team_id === String(clubId)));
    const gd = await pool(games, 4, (m) => tmCall(`/game/${m.match_id}`, 7 * 24 * HOUR));
    const tally = new Map();
    for (const g of gd) for (const a of g?.actions || []) {
      if (a.type !== "GOAL" || a.actionId === 206 || String(a.clubId) !== String(clubId)) continue;
      const add = (id, f) => { if (!id) return; const t = tally.get(String(id)) || { g: 0, a: 0 }; t[f]++; tally.set(String(id), t); };
      add(a.activePlayerId, "g"); add(a.passivePlayerId, "a");
    }
    const missing = [...tally.keys()].filter((id) => !pl[id]);
    const extra = missing.length ? await tmEntities("/players", missing).catch(() => ({})) : {};
    const scorers = [...tally.entries()].map(([id, t]) => ({ name: (pl[id] || extra[id])?.name || id, goals: t.g, assists: t.a }))
      .sort((a, b) => b.goals - a.goals || b.assists - a.assists).slice(0, 6);
    const total = squad.reduce((n, p) => n + (p.value || 0), 0);
    return { name: tmName(clubId, club?.name), stadium: stadium && { name: stadium.name, capacity: stadium.capacity, city: stadium.location?.city },
      coach: coaches[coachRec?.coachId]?.name || null, squad, squadValue: total, unavailable, scorers };
  })();
  teamMemo.set(clubId, { t: Date.now(), p });
  p.then((v) => teamMemo.set(clubId, { t: Date.now(), v })).catch(() => teamMemo.delete(clubId));
  return p;
}
const mln = (v) => (v == null ? null : Math.round(v / 100000) / 10);
const withDeadline = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]).catch(() => null);
function teamCtx(t) {
  if (!t) return undefined;
  return { trener: t.coach, wartosc_skladu_mln_eur: mln(t.squadValue),
    najcenniejsi_zawodnicy: t.squad.slice(0, 5).map((p) => `${p.name} (${p.detail || p.position}, ${mln(p.value)} mln €)`),
    niedostepni_zawodnicy: t.unavailable.map((u) => `${u.name} – ${u.reason}${u.until ? " do " + u.until : ""}`),
    najlepsi_strzelcy_druzyny: t.scorers.slice(0, 3).map((s) => `${s.name}: ${s.goals} goli, ${s.assists} asyst`) };
}

async function teamPage(clubId) {
  const P = "tm-", season = await tmSeason(), rows = await tmTable(season);
  const row = rows.find((r) => r.team.id === P + clubId);
  if (!row) throw new HttpErr(404, "Nie znaleziono drużyny w tabeli Ekstraklasy");
  const fin = season.matches.filter((m) => m.status === "finished" && m.home != null).sort((a, b) => b.timestamp - a.timestamp);
  const mine = fin.filter((m) => m.home_team.team_id === clubId || m.away_team.team_id === clubId);
  const now = Date.now() / 1000;
  const nextM = season.matches.filter((m) => (m.status === "notstarted" || m.status === "inprogress") && m.timestamp > now - 4 * 3600 &&
    (m.home_team.team_id === clubId || m.away_team.team_id === clubId)).sort((a, b) => a.timestamp - b.timestamp)[0];
  let next = null, h2h = [];
  if (nextM) {
    const home = nextM.home_team.team_id === clubId, opp = home ? nextM.away_team : nextM.home_team;
    h2h = fin.filter((m) => [m.home_team.team_id, m.away_team.team_id].includes(clubId) && [m.home_team.team_id, m.away_team.team_id].includes(opp.team_id))
      .map((m) => `${m.home_team.name} ${m.home}:${m.away} ${m.away_team.name} (${m.round})`);
    next = { eventId: P + nextM.match_id, home, opponent: opp.name, opponentId: P + opp.team_id, round: roundNo(nextM.round), date: nextM.timestamp };
  }
  ensureGames(season);
  const info = await tmTeam(clubId, season);
  const profile = GAMES.running ? null : leagueProfiles(season).teams.find((t) => t.id === P + clubId) || null;
  return { profile, profileProgress: { done: GAMES.done, total: GAMES.total }, team: { id: P + clubId, name: row.team.name }, table: row, form: fsFormOf(mine, clubId, 6), next, h2h, stats: fsStats(mine, clubId),
    stadium: info.stadium, coach: info.coach, squad: info.squad, squadValue: info.squadValue, unavailable: info.unavailable, scorers: info.scorers, note: seasonNote(season) };
}

// ---------- analiza AI na danych z Flashscore (wszystko z danych sezonu – 0 dodatkowych zapytań) ----------
function recOf(ms, id, home) {
  const r = { M: 0, Z: 0, R: 0, P: 0, gz: 0, gs: 0 };
  for (const m of ms) {
    const isH = m.home_team.team_id === id; if (home !== undefined && isH !== home) continue;
    const gf = isH ? m.home : m.away, ga = isH ? m.away : m.home;
    r.M++; r.gz += gf; r.gs += ga; if (gf > ga) r.Z++; else if (gf < ga) r.P++; else r.R++;
  }
  return { mecze: r.M, zwyciestwa: r.Z, remisy: r.R, porazki: r.P, bramki: `${r.gz}:${r.gs}`, punkty: r.Z * 3 + r.R };
}
function fsFormOf(ms, id, n = 6) {
  return ms.slice(0, n).map((m) => {
    const home = m.home_team.team_id === id, gf = home ? m.home : m.away, ga = home ? m.away : m.home, o = home ? m.away_team : m.home_team;
    return { eventId: pfxOf(m) + m.match_id, date: new Date(m.timestamp * 1000).toISOString().slice(0, 10), opponent: o.name, home, gf, ga,
      res: gf > ga ? "Z" : gf < ga ? "P" : "R", homeTeamId: pfxOf(m) + m.home_team.team_id, awayTeamId: pfxOf(m) + m.away_team.team_id };
  });
}
function fsStats(ms, id) {
  const n = ms.length || 1; let gf = 0, ga = 0, cs = 0, btts = 0, o25 = 0;
  for (const m of ms) { const h = m.home_team.team_id === id, a = h ? m.home : m.away, b = h ? m.away : m.home;
    gf += a; ga += b; if (b === 0) cs++; if (a > 0 && b > 0) btts++; if (a + b > 2) o25++; }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { mecze: ms.length, srednia_goli_zdobytych: r2(gf / n), srednia_goli_straconych: r2(ga / n), czyste_konta: cs, mecze_z_golami_obu_druzyn: btts, mecze_powyzej_2_5_gola: o25,
    u_siebie: recOf(ms, id, true), na_wyjezdzie: recOf(ms, id, false) };
}

// ---------- tabele cząstkowe (dom / wyjazd / forma) ----------
function splitTable(season, mode) {
  const P = season.tm ? "tm-" : "fs-", t = new Map();
  const get = (tm) => { if (!t.has(tm.team_id)) t.set(tm.team_id, { id: tm.team_id, name: tm.name, n: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }); return t.get(tm.team_id); };
  const fin = season.matches.filter((m) => m.status === "finished" && m.home != null && m.away != null).sort((a, b) => b.timestamp - a.timestamp);
  for (const m of season.matches) { get(m.home_team); get(m.away_team); }
  const left = new Map(); // forma: ostatnie 5 meczów każdej drużyny
  const add = (r, gf, ga) => { r.n++; r.gf += gf; r.ga += ga; if (gf > ga) { r.w++; r.pts += 3; } else if (gf < ga) r.l++; else { r.d++; r.pts++; } };
  for (const m of fin) {
    const hr = get(m.home_team), ar = get(m.away_team);
    if (mode === "home") add(hr, m.home, m.away);
    else if (mode === "away") add(ar, m.away, m.home);
    else { for (const [r, id, gf, ga] of [[hr, m.home_team.team_id, m.home, m.away], [ar, m.away_team.team_id, m.away, m.home]]) {
      const c = left.get(id) || 0; if (c < 5) { add(r, gf, ga); left.set(id, c + 1); } } }
  }
  return [...t.values()].sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.name.localeCompare(y.name, "pl"))
    .map((r, i) => ({ position: i + 1, team: { id: P + r.id, name: r.name }, matches: r.n, wins: r.w, draws: r.d, losses: r.l, scoresFor: r.gf, scoresAgainst: r.ga, points: r.pts }));
}

// ---------- królowie strzelców / asyst / kartek (agregacja wszystkich meczów z Transfermarkt) ----------
const LD = { running: false, done: 0, total: 0, data: null, at: 0, err: null, n: -1 };
async function computeLeaders(season) {
  LD.running = true; LD.err = null;
  try {
    const games = season.matches.filter((m) => m.status === "finished" && m.home != null);
    LD.done = 0; LD.total = games.length;
    let failed = 0;
    const gd = await pool(games, 5, async (m) => { try { const g = await tmCall(`/game/${m.match_id}`, 7 * 24 * HOUR); LD.done++; return g; } catch { failed++; LD.done++; return null; } });
    const P = new Map(), get = (id, club) => { id = String(id); if (!P.has(id)) P.set(id, { id, club: String(club || ""), g: 0, pen: 0, a: 0, y: 0, r: 0 }); const p = P.get(id); if (club) p.club = String(club); return p; };
    for (const g of gd) for (const a of g?.actions || []) {
      if (a.type === "GOAL" && a.actionId !== 206) {
        if (a.activePlayerId) { const p = get(a.activePlayerId, a.clubId); p.g++; if (a.actionId === 204 || a.actionId === 205) p.pen++; }
        if (a.passivePlayerId) get(a.passivePlayerId, a.clubId).a++;
      } else if (a.type === "CARD" && a.activePlayerId) { const p = get(a.activePlayerId, a.clubId); if (a.actionId === 301) p.y++; else p.r++; }
    }
    const pl = await tmEntities("/players", [...P.keys()]);
    const clubName = new Map(season.matches.flatMap((m) => [[m.home_team.team_id, m.home_team.name], [m.away_team.team_id, m.away_team.name]]));
    const all = [...P.values()].map((p) => ({ id: "tm-" + p.id, name: pl[p.id]?.name || p.id, club: clubName.get(p.club) || "", clubId: "tm-" + p.club, g: p.g, pen: p.pen, a: p.a, y: p.y, r: p.r }));
    const top = (key, f, k = 15) => all.filter((p) => f(p) > 0).sort(key).slice(0, k);
    LD.data = {
      scorers: top((x, y) => y.g - x.g || y.a - x.a || x.name.localeCompare(y.name, "pl"), (p) => p.g),
      assists: top((x, y) => y.a - x.a || y.g - x.g || x.name.localeCompare(y.name, "pl"), (p) => p.a),
      cards: top((x, y) => y.r * 3 + y.y - (x.r * 3 + x.y) || x.name.localeCompare(y.name, "pl"), (p) => p.y + p.r),
      matches: games.length, failed };
    LD.n = failed ? -1 : games.length; LD.at = failed ? Date.now() - 50 * 60000 : Date.now(); // przy błędach odświeżymy po ~10 min
  } catch (e) { LD.err = String(e.message || e); } finally { LD.running = false; }
}
async function leadersRoute() {
  const season = await tmSeason();
  const n = season.matches.filter((m) => m.status === "finished" && m.home != null).length;
  const fresh = LD.data && LD.n === n && Date.now() - LD.at < HOUR;
  if (!fresh && !LD.running && !(LD.err && Date.now() - LD.at < 5 * 60000)) { LD.at = LD.at || 0; computeLeaders(season).then(() => { if (LD.err) LD.at = Date.now(); }); }
  if (LD.data) return { ready: true, refreshing: LD.running, ...LD.data };
  if (LD.err && !LD.running) throw new HttpErr(502, "Nie udało się policzyć rankingów: " + LD.err);
  return { ready: false, done: LD.done, total: LD.total || n };
}

// ---------- dane meczowe: statystyki klubów, minuty i rodzaje goli ze wszystkich rozegranych meczów ----------
const GAMES = { map: new Map(), running: null, done: 0, total: 0 };
function slimGame(g) {
  const side = (c) => { const ps = c?.lineup?.players || [], ages = ps.map((p) => p.ageAtGameDate).filter(Number.isFinite);
    return { id: String(c?.clubId), tactic: c?.tactic?.tactic || null, st: c?.clubStatistics || {}, age: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null, value: c?.squadMarketValue?.value ?? null }; };
  return { home: side(g.homeClub), away: side(g.awayClub), hs: g.score?.home, as: g.score?.away,
    goals: (g.actions || []).filter((a) => a.type === "GOAL").map((a) => ({ min: a.minute || 0, add: a.addedTime || 0, club: String(a.clubId), kind: a.actionId })),
    cards: (g.actions || []).filter((a) => a.type === "CARD").map((a) => ({ club: String(a.clubId), kind: a.actionId })) };
}
function ensureGames(season) {
  const need = season.matches.filter((m) => m.status === "finished" && m.home != null && !GAMES.map.has(String(m.match_id)));
  if (!need.length) return null;
  if (GAMES.running) return GAMES.running;
  GAMES.total = need.length; GAMES.done = 0;
  GAMES.running = pool(need, 5, async (m) => {
    try { const g = await tmCall(`/game/${m.match_id}`, 7 * 24 * HOUR); if (g) GAMES.map.set(String(m.match_id), slimGame(g)); } catch {}
    GAMES.done++;
  }).finally(() => { GAMES.running = null; });
  return GAMES.running;
}

// ---------- profil gry drużyny ----------
const PERIODS = ["1–15'", "16–30'", "31–45'", "46–60'", "61–75'", "76–90'"];
const periodOf = (min) => (min <= 15 ? 0 : min <= 30 ? 1 : min <= 45 ? 2 : min <= 60 ? 3 : min <= 75 ? 4 : 5);
// key, etykieta, grupa, format, wyżej=lepiej (null = cecha stylu, bez oceny), [mocna strona, słaba strona]
const METRICS = [
  ["gf", "Bramki zdobyte / mecz", "Atak", "n2", true, ["Najskuteczniejszy atak", "Mało bramek"]],
  ["shots", "Strzały / mecz", "Atak", "n1", true, ["Dużo strzałów", "Rzadko strzela"]],
  ["sotPct", "Celność strzałów", "Atak", "pct", true, ["Celne strzały", "Strzela niecelnie"]],
  ["conv", "Skuteczność (gole / strzały)", "Atak", "pct", true, ["Zamienia okazje na gole", "Marnuje okazje"]],
  ["corners", "Rzuty rożne / mecz", "Atak", "n1", true, ["Często zmusza rywala do rożnych", "Rzadko wymusza rożne"]],
  ["ga", "Bramki stracone / mecz", "Obrona", "n2", false, ["Szczelna obrona", "Traci dużo bramek"]],
  ["shotsAg", "Strzały rywali / mecz", "Obrona", "n1", false, ["Ogranicza strzały rywali", "Pozwala rywalom strzelać"]],
  ["sotAg", "Celne strzały rywali / mecz", "Obrona", "n1", false, ["Rzadko zagrożona celnymi strzałami", "Dużo celnych strzałów rywali"]],
  ["cs", "Mecze z czystym kontem", "Obrona", "pct", true, ["Często zachowuje czyste konto", "Rzadko zachowuje czyste konto"]],
  ["tackleSucc", "Skuteczność odbiorów", "Obrona", "pct", true, ["Skuteczne w odbiorze", "Przegrywa pojedynki"]],
  ["tackles", "Odbiory / mecz", "Obrona", "n1", null, []],
  ["clearances", "Wybicia / mecz", "Obrona", "n1", null, []],
  ["poss", "Posiadanie piłki", "Kontrola gry", "pct", null, []],
  ["passes", "Podania / mecz", "Kontrola gry", "n0", null, []],
  ["passAcc", "Celność podań", "Kontrola gry", "pct", true, ["Dokładne w rozegraniu", "Niedokładne podania"]],
  ["offsides", "Spalone / mecz", "Kontrola gry", "n1", false, ["Rzadko łapie się na spalonym", "Często łapie się na spalonym"]],
  ["fouls", "Faule / mecz", "Dyscyplina", "n1", false, ["Gra czysto", "Dużo fauli"]],
  ["yellow", "Żółte kartki / mecz", "Dyscyplina", "n2", false, ["Mało kartek", "Dużo kartek"]],
  ["late", "Bramki po 75. minucie (zdobyte)", "Charakter", "n0", true, ["Groźna w końcówkach", "Rzadko trafia w końcówkach"]],
  ["lateAg", "Bramki po 75. minucie (stracone)", "Charakter", "n0", false, ["Pewna w końcówkach", "Traci bramki w końcówkach"]],
  ["firstPts", "Punkty / mecz po zdobyciu pierwszego gola", "Charakter", "n2", true, ["Potrafi dowieźć prowadzenie", "Roztrwania prowadzenie"]],
  ["behindPts", "Punkty / mecz po straconym pierwszym golu", "Charakter", "n2", true, ["Odrabia straty", "Po straconym golu rzadko punktuje"]],
  ["homePpg", "Punkty / mecz u siebie", "Charakter", "n2", true, ["Twierdza na własnym stadionie", "Słabo punktuje u siebie"]],
  ["awayPpg", "Punkty / mecz na wyjeździe", "Charakter", "n2", true, ["Groźna na wyjazdach", "Słabo punktuje na wyjazdach"]],
  ["age", "Średni wiek wyjściowej jedenastki", "Skład", "n1", null, []],
];
const GT = { head: [203], pen: [204, 205], set: [207, 211], long: [209], counter: [208] };
function rawProfile(season, id) {
  const fin = season.matches.filter((m) => m.status === "finished" && m.home != null && (m.home_team.team_id === id || m.away_team.team_id === id)).sort((a, b) => a.timestamp - b.timestamp);
  const acc = { n: 0, ns: 0, goalsFor: 0, goalsAg: 0, gamesCS: 0 }, S = {}, add = (k, v) => { if (Number.isFinite(v)) { (S[k] ||= [0, 0]); S[k][0] += v; S[k][1]++; } };
  const timing = { scored: Array(6).fill(0), conceded: Array(6).fill(0) }, types = { head: 0, pen: 0, set: 0, long: 0, counter: 0, own: 0, open: 0, total: 0 };
  const forms = new Map(), ppg = { h: [0, 0], a: [0, 0] }, first = { sP: 0, sN: 0, cP: 0, cN: 0 }, ages = [];
  let late = 0, lateAg = 0, withData = 0, value = null;
  for (const m of fin) {
    const home = m.home_team.team_id === id, gf = home ? m.home : m.away, ga = home ? m.away : m.home, pts = gf > ga ? 3 : gf === ga ? 1 : 0;
    acc.n++; acc.goalsFor += gf; acc.goalsAg += ga; if (ga === 0) acc.gamesCS++;
    const pp = home ? ppg.h : ppg.a; pp[0] += pts; pp[1]++;
    const g = GAMES.map.get(String(m.match_id)); if (!g) continue;
    withData++;
    const me = home ? g.home : g.away, op = home ? g.away : g.home, st = me.st, os = op.st;
    add("poss", st.gameStatistics?.possessionPercentage); add("passes", st.passingStatistics?.totalPasses);
    if (st.passingStatistics?.totalPasses) { add("passAccN", st.passingStatistics.accuratePasses); add("passAccD", st.passingStatistics.totalPasses); }
    add("shots", st.goalStatistics?.totalShotAttempts); add("sot", st.goalStatistics?.onTargetShotAttempts);
    add("shotsAg", os.goalStatistics?.totalShotAttempts); add("sotAg", os.goalStatistics?.onTargetShotAttempts);
    add("tackles", st.defensiveStatistics?.totalTackles); add("tackS", st.defensiveStatistics?.successfulTackles);
    add("clearances", st.defensiveStatistics?.clearances); add("offsides", st.defensiveStatistics?.offsides);
    add("corners", st.setPieceStatistics?.cornersTaken); add("fouls", st.penaltyStatistics?.freeKicksConcededFromFouls);
    add("yellow", st.gameStatistics?.yellowCards);
    if (me.tactic) forms.set(me.tactic, (forms.get(me.tactic) || 0) + 1);
    if (me.age != null) ages.push(me.age); if (me.value) value = me.value;
    const gl = g.goals.map((x) => ({ ...x, t: x.min + x.add / 100 })).sort((a, b) => a.t - b.t);
    for (const x of gl) {
      const mine = x.club === id; (mine ? timing.scored : timing.conceded)[periodOf(x.min)]++;
      if (x.min > 75) { if (mine) late++; else lateAg++; }
      if (mine) { types.total++; const k = Object.keys(GT).find((q) => GT[q].includes(x.kind)); if (x.kind === 206) { types.own++; } else if (k) types[k]++; else types.open++; }
    }
    if (gl[0]) { if (gl[0].club === id) { first.sP += pts; first.sN++; } else { first.cP += pts; first.cN++; } }
  }
  const avg = (k) => (S[k] ? S[k][0] / S[k][1] : null), ratio = (a, b) => (a != null && b ? a / b : null), per = (a, n) => (n ? a / n : null);
  const sumOf = (k) => (S[k] ? S[k][0] : 0);
  const v = {
    gf: per(acc.goalsFor, acc.n), ga: per(acc.goalsAg, acc.n), cs: per(acc.gamesCS, acc.n) != null ? (acc.gamesCS / acc.n) * 100 : null,
    shots: avg("shots"), sotPct: S.shots ? (sumOf("sot") / sumOf("shots")) * 100 : null, conv: S.shots ? (fin.filter((m) => GAMES.map.has(String(m.match_id))).reduce((a, m) => a + (m.home_team.team_id === id ? m.home : m.away), 0) / sumOf("shots")) * 100 : null,
    corners: avg("corners"), shotsAg: avg("shotsAg"), sotAg: avg("sotAg"), tackles: avg("tackles"), tackleSucc: S.tackles ? (sumOf("tackS") / sumOf("tackles")) * 100 : null,
    clearances: avg("clearances"), poss: avg("poss"), passes: avg("passes"), passAcc: S.passAccD ? (sumOf("passAccN") / sumOf("passAccD")) * 100 : null,
    offsides: avg("offsides"), fouls: avg("fouls"), yellow: avg("yellow"), late, lateAg,
    firstPts: first.sN >= 3 ? first.sP / first.sN : null, behindPts: first.cN >= 3 ? first.cP / first.cN : null,
    homePpg: per(ppg.h[0], ppg.h[1]), awayPpg: per(ppg.a[0], ppg.a[1]), age: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null };
  const gtot = types.total || 1;
  return { v, withData, matches: acc.n, timing, types, typeShare: { head: types.head / gtot, set: types.set / gtot, pen: types.pen / gtot, long: types.long / gtot, counter: types.counter / gtot },
    formations: [...forms.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })), value, first };
}
const fmtV = (f, x) => (x == null ? "–" : f === "pct" ? `${Math.round(x * 10) / 10}%` : f === "n0" ? String(Math.round(x * 10) / 10).replace(/\.0$/, "") : f === "n1" ? (Math.round(x * 10) / 10).toFixed(1) : (Math.round(x * 100) / 100).toFixed(2));
let profMemo = null;
function leagueProfiles(season) {
  const key = `${season.matches.filter((m) => m.status === "finished").length}:${GAMES.map.size}`;
  if (profMemo?.key === key) return profMemo.v;
  const ids = [...new Set(season.matches.flatMap((m) => [m.home_team.team_id, m.away_team.team_id]))];
  const names = new Map(season.matches.flatMap((m) => [[m.home_team.team_id, m.home_team.name], [m.away_team.team_id, m.away_team.name]]));
  const raw = new Map(ids.map((id) => [id, rawProfile(season, id)]));
  const ranks = new Map(ids.map((id) => [id, {}])), avgs = {}, ext = {};
  for (const [k, , , , hi] of METRICS) {
    const arr = ids.map((id) => [id, raw.get(id).v[k]]).filter(([, x]) => x != null);
    if (!arr.length) continue;
    const dirHigh = hi !== false; arr.sort((a, b) => (dirHigh ? b[1] - a[1] : a[1] - b[1]));
    arr.forEach(([id], i) => { ranks.get(id)[k] = i + 1; });
    avgs[k] = arr.reduce((a, b) => a + b[1], 0) / arr.length; ext[k] = { n: arr.length, best: arr[0][1], worst: arr[arr.length - 1][1] };
  }
  const teams = ids.map((id) => {
    const r = raw.get(id), rk = ranks.get(id);
    const N = (k) => ext[k]?.n || ids.length;
    const judged = METRICS.filter(([k, , , , hi]) => hi !== null && rk[k] && r.withData >= 5 || (hi !== null && ["homePpg", "awayPpg"].includes(k) && rk[k]));
    const scored = judged.map(([k, label, grp, f, hi, ph]) => ({ k, label, f, ph, r: rk[k], val: r.v[k], s: (N(k) + 1 - 2 * rk[k]) / (N(k) - 1) }));
    const fmtS = (x, top) => `${top ? x.ph[0] : x.ph[1]} — ${x.label.toLowerCase()}: ${fmtV(x.f, x.val)} (${x.r}. w lidze${x.r === 1 ? " – najlepszy wynik" : x.r === N(x.k) ? " – najgorszy wynik" : ""})`;
    const strengths = scored.filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => fmtS(x, true));
    const weaknesses = scored.filter((x) => x.s <= -0.5).sort((a, b) => a.s - b.s).slice(0, 5).map((x) => fmtS(x, false));
    const tags = [], R = (k) => rk[k] || 99, n = ids.length;
    if (r.withData >= 5) {
      if (R("poss") <= 5 && R("passAcc") <= 8) tags.push("Gra pozycyjna"); else if (R("poss") <= 4) tags.push("Dominuje w posiadaniu");
      if (R("poss") >= n - 5) tags.push(R("clearances") <= 5 ? "Głęboka obrona" : "Niskie posiadanie");
      if (R("poss") >= n - 6 && r.typeShare.counter + r.typeShare.long > 0.12) tags.push("Groźna z kontry");
      if (R("ga") <= 3) tags.push("Szczelna defensywa"); if (R("gf") <= 3) tags.push("Skuteczny atak");
      if (R("shots") <= 3) tags.push("Dużo strzałów");
      if (r.types.total >= 8 && r.typeShare.set >= 0.2) tags.push("Groźna po stałych fragmentach");
      if (r.types.total >= 8 && r.typeShare.head >= 0.25) tags.push("Gra górą");
      if (R("late") <= 3) tags.push("Mocna końcówkami");
      if (R("behindPts") <= 3) tags.push("Odrabia straty");
      if (R("fouls") >= n - 2 || R("yellow") >= n - 2) tags.push("Twarda, kartkowa gra");
    }
    const pct = (k) => (rk[k] ? Math.round(((N(k) - rk[k]) / (N(k) - 1)) * 100) : null);
    return { id: "tm-" + id, name: names.get(id), matches: r.matches, withData: r.withData,
      metrics: Object.fromEntries(METRICS.map(([k]) => [k, r.v[k] == null ? null : Math.round(r.v[k] * 100) / 100])),
      ranks: rk, pct: Object.fromEntries(METRICS.map(([k]) => [k, pct(k)])), strengths, weaknesses, tags: tags.slice(0, 5),
      timing: r.timing, types: r.types, formations: r.formations.slice(0, 3), value: r.value };
  });
  const v = { defs: METRICS.map(([key, label, group, f, hi]) => ({ key, label, group, fmt: f, better: hi === null ? null : hi ? "high" : "low", avg: avgs[key] ?? null })), teams,
    ready: !GAMES.running && GAMES.map.size > 0, progress: { done: GAMES.done, total: GAMES.total } };
  profMemo = { key, v }; return v;
}
async function profilesRoute() {
  const season = await tmSeason();
  ensureGames(season);
  const v = leagueProfiles(season);
  return { ...v, ready: !GAMES.running, progress: { done: GAMES.done, total: GAMES.total }, note: seasonNote(season) };
}

// ---------- opis stylu gry przez AI (bez prognoz i typów) ----------
async function profileAi(clubId) {
  const season = await tmSeason(); await ensureGames(season);
  const P = leagueProfiles(season), t = P.teams.find((x) => x.id === "tm-" + clubId);
  if (!t) throw new HttpErr(404, "Nie znaleziono drużyny");
  const key = `prof:${clubId}:${t.matches}`, hit = analysisCache.get(key);
  if (hit && Date.now() - hit.t < 6 * HOUR) return hit.v;
  const t0 = Date.now(); analysisLog = analysisLog.filter((x) => t0 - x < HOUR);
  if (analysisLog.length >= 20) throw new HttpErr(429, "Limit 20 opisów na godzinę został osiągnięty. Spróbuj później.");
  const rows = await tmTable(season), row = rows.find((r) => r.team.id === "tm-" + clubId);
  const fin = season.matches.filter((m) => m.status === "finished" && m.home != null).sort((a, b) => b.timestamp - a.timestamp);
  const mine = fin.filter((m) => m.home_team.team_id === clubId || m.away_team.team_id === clubId);
  const info = await withDeadline(tmTeam(clubId, season), 30000);
  const mets = P.defs.map((d) => `${d.label}: ${fmtV(d.fmt, t.metrics[d.key])} (${t.ranks[d.key] ? t.ranks[d.key] + ". w lidze, średnia ligi " + fmtV(d.fmt, d.avg) : "brak"})`);
  const ctx = { druzyna: t.name, tabela: row && { miejsce: row.position, punkty: row.points, bilans: `${row.wins}-${row.draws}-${row.losses}`, bramki: `${row.scoresFor}:${row.scoresAgainst}` },
    forma: fsFormOf(mine, clubId, 6).map((m) => `${m.home ? "(d)" : "(w)"} ${m.opponent} ${m.gf}:${m.ga}`), statystyki_na_tle_ligi: mets,
    mocne_strony_z_danych: t.strengths, slabe_strony_z_danych: t.weaknesses, etykiety_stylu: t.tags,
    minuty_goli: Object.fromEntries(PERIODS.map((p, i) => [p, `zdobyte ${t.timing.scored[i]}, stracone ${t.timing.conceded[i]}`])),
    jak_strzela_bramki: t.types, najczestsze_ustawienia: t.formations, trener: info?.coach, najlepsi_strzelcy: info?.scorers?.slice(0, 4).map((s) => `${s.name}: ${s.goals} goli, ${s.assists} asyst`),
    niedostepni: info?.unavailable?.map((u) => `${u.name} – ${u.reason}`), wartosc_skladu_mln_eur: info ? mln(info.squadValue) : null };
  analysisLog.push(t0);
  const system = "Jesteś analitykiem taktycznym polskiej Ekstraklasy. Opisujesz, JAK GRA drużyna: styl, mocne i słabe strony. Opierasz się WYŁĄCZNIE na dostarczonych danych " +
    "(nie wymyślaj faktów, których tam nie ma). NIE podajesz prognoz wyników, typów ani szans na wygraną i nie odnosisz się do zakładów. Piszesz po polsku, rzeczowo i przystępnie dla kibica. Zwracasz wyłącznie jeden obiekt JSON, bez markdown.";
  const user = `Dane:\n${JSON.stringify(ctx, null, 1)}\n\nZwróć JSON o schemacie:\n{"w_skrocie":"2 zdania: jaką drużyną jest ${t.name}","styl_gry":"3-4 zdania o stylu (posiadanie, tempo, ustawienie, jak buduje akcje)",` +
    `"jak_atakuje":"2-3 zdania","jak_sie_broni":"2-3 zdania","mocne_strony":["..","..",".."],"slabe_strony":["..","..",".."],"kluczowi_zawodnicy":["imię i nazwisko – krótko dlaczego"],"na_co_zwrocic_uwage":["..",".."]}`;
  const text = await nvidia([{ role: "system", content: system }, { role: "user", content: user }]);
  const v = { ai: parseJson(text), raw: null, model: NV_MODEL, generatedAt: Date.now() };
  if (!v.ai) v.raw = text;
  analysisCache.set(key, { t: Date.now(), v });
  return v;
}

// ---------- podgląd meczu przed startem (bez prognoz) ----------
async function previewPage(matchId) {
  const season = await tmSeason(), m = season.matches.find((x) => String(x.match_id) === String(matchId));
  if (!m) throw new HttpErr(404, "Nie znaleziono meczu");
  const rows = await tmTable(season), hid = m.home_team.team_id, aid = m.away_team.team_id;
  const fin = season.matches.filter((x) => x.status === "finished" && x.home != null).sort((a, b) => b.timestamp - a.timestamp);
  const mine = (id) => fin.filter((x) => x.home_team.team_id === id || x.away_team.team_id === id);
  const h2h = fin.filter((x) => [x.home_team.team_id, x.away_team.team_id].includes(hid) && [x.home_team.team_id, x.away_team.team_id].includes(aid))
    .map((x) => ({ eventId: "tm-" + x.match_id, home: x.home_team.name, away: x.away_team.name, score: `${x.home}:${x.away}`, round: x.round, date: x.timestamp }));
  const [th, ta] = await Promise.all([withDeadline(tmTeam(hid, season), 12000), withDeadline(tmTeam(aid, season), 12000)]);
  const side = (id, t) => ({ id: "tm-" + id, table: rows.find((r) => r.team.id === "tm-" + id) || null, form: fsFormOf(mine(id), id, 5), stats: fsStats(mine(id), id),
    unavailable: t ? t.unavailable : null, scorers: t ? t.scorers.slice(0, 3) : null, value: t ? mln(t.squadValue) : null, coach: t?.coach || null });
  return { event: fsEv(m), home: side(hid, th), away: side(aid, ta), h2h, loading: !th || !ta, note: seasonNote(season) };
}

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) throw new HttpErr(503, "Brak TELEGRAM_BOT_TOKEN lub TELEGRAM_CHAT_ID");
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new HttpErr(502, `Telegram: ${r.status}`);
}
const liveSeen = new Map(); let watchInit = false;
async function lastScorer(m) { // kto strzelił ostatnią bramkę (best effort)
  try {
    const g = await withDeadline(tmCall(`/game/${m.match_id}`, 30000), 6000);
    const a = [...(g?.actions || [])].reverse().find((x) => x.type === "GOAL");
    if (!a?.activePlayerId) return "";
    const p = await withDeadline(tmEntities("/players", [a.activePlayerId]), 4000);
    const n = p?.[String(a.activePlayerId)]?.name;
    return n ? ` — ${n}${a.actionId === 206 ? " (sam.)" : a.actionId === 204 || a.actionId === 205 ? " (k.)" : ""}` : "";
  } catch { return ""; }
}
async function watchLive(season) {
  if (!season?.tm) return;
  const msgs = [];
  for (const m of season.matches) {
    const key = m.match_id, prev = liveSeen.get(key), cur = { status: m.status, home: m.home, away: m.away };
    if (watchInit && m.status !== "notstarted" && m.status !== "postponed") {
      const nm = `${m.home_team.name} ${m.home ?? 0}:${m.away ?? 0} ${m.away_team.name}`;
      if (!prev || prev.status === "notstarted") { if (m.status === "inprogress") msgs.push(`🟢 Początek meczu: ${m.home_team.name} – ${m.away_team.name}`); }
      else if (prev.status === "inprogress" && m.status === "finished") msgs.push(`🏁 Koniec: ${nm}`);
      if (prev && (prev.home !== m.home || prev.away !== m.away) && m.home != null && prev.status !== "finished") msgs.push(`⚽ GOL! ${nm}${m.live ? ` (${m.live})` : ""}${await lastScorer(m)}`);
    }
    liveSeen.set(key, cur);
  }
  watchInit = true;
  if (TG_TOKEN && TG_CHAT) for (const t of msgs) await tgSend(t).catch((e) => console.error("telegram:", e.message));
  return msgs.length;
}

let lastTick = 0, tickRunning = false, lastTickInfo = null;
async function tick(force = false) { // budzi serwis, odświeża dane meczowe i pilnuje powiadomień o meczach
  if (tickRunning) return { skipped: "trwa", last: lastTickInfo };
  if (!force && Date.now() - lastTick < 5 * 60000) return { skipped: "za wcześnie", last: lastTickInfo };
  tickRunning = true; lastTick = Date.now();
  const info = { at: new Date().toISOString(), games: 0, notified: 0 };
  try {
    const season = await tmSeason();
    info.notified = (await watchLive(season).catch(() => 0)) || 0;
    ensureGames(season); info.games = GAMES.map.size;
  } catch (e) { info.error = String(e.message || e); } finally { tickRunning = false; lastTickInfo = info; }
  return info;
}

// ---------- routing ----------
// Flashscore jako źródło główne; przy błędzie – stare źródło (SportAPI7).
async function withFs(fsFn, oldFn) {
  let fsErr;
  try { return { status: 200, data: await fsFn() }; } catch (e) { fsErr = e; }
  const r = await oldFn();
  if (r.status !== 200) return { status: r.status, data: { error: `Flashscore: ${fsErr.message} · SportAPI7: ${r.data?.error || r.status}` } };
  return r;
}
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function route(p) {
  let m;
  if (p === "/api/status") {
    return { status: 200, data: { transfermarkt: { ok: Date.now() >= tmFailUntil }, flashscore: { remaining: fsLeft, resetAt: fsLeft === null ? null : new Date(fsResetAt).toISOString(), limit: 30 }, seed: SEED?.savedAt || null, telegram: !!(TG_TOKEN && TG_CHAT), aiLastHour: analysisLog.filter((t) => Date.now() - t < HOUR).length, lastTick: lastTickInfo } };
  }
  if ((m = p.match(/^\/api\/table\/(home|away|form)$/))) { const s = await anySeason(); return { status: 200, data: { standings: [{ rows: splitTable(s, m[1]) }], note: seasonNote(s) } }; }
  if (p === "/api/leaders") return { status: 200, data: await leadersRoute() };
  if ((m = p.match(/^\/api\/preview\/tm-(\d+)$/))) return { status: 200, data: await previewPage(m[1]) };
  if (p === "/api/tick") return { status: 200, data: await tick() };
  if (p === "/api/telegram-test") { await tgSend("✅ Ekstraklasa: powiadomienia Telegram działają."); return { status: 200, data: { ok: true } }; }
  if ((m = p.match(/^\/api\/team\/tm-(\d+)$/))) return { status: 200, data: await teamPage(m[1]) };
  if (p === "/api/table") {
    return withFs(async () => {
      const s = await anySeason();
      return { standings: [{ rows: await seasonTable(s) }], note: seasonNote(s) };
    }, async () => {
      const s = await seasonId();
      return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/standings/total`, 600000);
    });
  }
  if (p === "/api/rounds") {
    return withFs(async () => { const s = await anySeason(); return { ...fsRounds(s.matches), note: seasonNote(s) }; }, async () => {
      const s = await seasonId();
      return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/rounds`, 1800000);
    });
  }
  if ((m = p.match(/^\/api\/round\/(\d{1,2})$/))) {
    return withFs(async () => {
      const s = await anySeason();
      return { events: s.matches.filter((x) => roundNo(x.round) === Number(m[1])).map(fsEv), note: seasonNote(s) };
    }, async () => {
      const s = await seasonId();
      return callApi(`/api/v1/unique-tournament/${TOURNAMENT}/season/${s}/events/round/${m[1]}`, 300000);
    });
  }
  if (p === "/api/live") {
    try {
      const s = await anySeason();
      const events = s.tm ? s.matches.filter((m) => m.status === "inprogress").map(fsEv) : await fsLive(s);
      if (s.tm) watchLive(s).catch(() => {});
      return { status: 200, data: { source: s.tm ? "transfermarkt" : "flashscore", events, note: seasonNote(s) } };
    } catch {}
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
  if ((m = p.match(/^\/api\/event\/(fs-[A-Za-z0-9]+|tm-\d+|af-\d+|\d+)(?:\/(stats|lineups|incidents))?$/))) {
    if (m[1].startsWith("fs-")) return { status: 200, data: await fsEventRoute(m[1].slice(3), m[2]) };
    if (m[1].startsWith("tm-")) return { status: 200, data: await tmEventRoute(m[1].slice(3), m[2]) };
    if (m[1].startsWith("af-")) return { status: 200, data: await afEventRoute(m[1].slice(3), m[2]) };
    const sub = { stats: "/statistics", lineups: "/lineups", incidents: "/incidents" }[m[2]] || "";
    return callApi(`/api/v1/event/${m[1]}${sub}`, m[2] ? 3600000 : 120000);
  }
  if ((m = p.match(/^\/api\/heatmap\/(\d+)\/(\d+)$/))) {
    return callApi(`/api/v1/event/${m[1]}/player/${m[2]}/heatmap`, 3600000);
  }
  if ((m = p.match(/^\/api\/profile-ai\/tm-(\d+)$/))) return { status: 200, data: await profileAi(m[1]) };
  if (p === "/api/profiles") return { status: 200, data: await profilesRoute() };
  return { status: 404, data: { error: "Nieznany endpoint" } };
}

const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/icon-192.png": { file: "icon-192.png", type: "image/png" },
  "/icon-512.png": { file: "icon-512.png", type: "image/png" },
};
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

  const f = STATIC[p] || STATIC["/"];
  fs.readFile(path.join(__dirname, f.file), (err, buf) => {
    if (err) { res.writeHead(500); return res.end("Brak pliku " + f.file); }
    res.writeHead(200, { "Content-Type": f.type, "Cache-Control": f.file === "index.html" || f.file === "sw.js" ? "no-cache" : "public, max-age=86400" });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Ekstraklasa działa na http://localhost:${PORT}`));
// pętla w procesie (gdy serwis nie śpi); gdy śpi – budzi go zewnętrzny ping /api/tick
setInterval(() => { tick().catch(() => {}); }, 10 * 60000).unref();
setTimeout(() => { tick().catch(() => {}); }, 20000).unref();
