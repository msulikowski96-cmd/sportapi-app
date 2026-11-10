# Ekstraklasa – aplikacja webowa

Mecze na żywo, kolejki, tabela, szczegóły meczu i analiza AI (NVIDIA Nemotron) polskiej Ekstraklasy.

## Źródła danych
2. **Flashscore API** (RapidAPI `flashscore-api1`) – główne. Plan darmowy = **30 zapytań na dobę**, dlatego serwer
   pobiera cały sezon (wyniki + terminarz = 4 zapytania, cache 2–6 h) i z niego liczy kolejki, tabelę i formę.
   Gdy limit się skończy, używa ostatnich danych z pamięci albo zapisu `fs-seed.json`.
3. **SportAPI7** (RapidAPI) – zapasowe; jedyne źródło heatmap zawodników.
4. **API-Football** – zapasowe dla meczów na żywo (okno wczoraj–jutro).

## Zmienne środowiskowe (tylko na serwerze, nie w repozytorium)
`RAPIDAPI_KEY` (wspólny dla Flashscore i SportAPI7), `NVIDIA_API_KEY`, `API_FOOTBALL_KEY` (opcjonalny).

## Uruchomienie
`node server.js` (Node 18+, bez zależności). `/api/status` pokazuje pozostały dzienny limit Flashscore.

## Transfermarkt (źródło główne od 10.11.2026)
Tabela, kolejki, mecze na żywo, przebieg, statystyki i składy pochodzą z JSON API Transfermarkt
(`tmapi.transfermarkt.technology`, to samo, z którego korzysta [felipeall/transfermarkt-api](https://github.com/felipeall/transfermarkt-api)) –
bez klucza i bez dziennego limitu. API jest nieudokumentowane; gdy zablokuje zapytania, serwer przechodzi na Flashscore.

## Nowe (10.11.2026)
- **Analiza AI** dostaje też dane z Transfermarkt: skład i wartości rynkowe, kontuzje/zawieszenia (22 najcenniejszych zawodników), trenera i strzelców.
- **Zakładka Drużyny** (`/api/team/tm-ID`): skład z wartościami, niedostępni, strzelcy, forma, następny mecz i bilans z rywalem.
- **Zakładka Trafność** (`/api/predictions`): prognozy z analiz zapisują się w bazie Neon Postgres (zmienna `DATABASE_URL`) i rozliczają po meczu.


## Profil gry drużyn (listopad 2026)
Aplikacja pokazuje, **jak grają drużyny** (nie jest narzędziem do typowania wyników).
- **Profil drużyny:** ~25 statystyk z meczów sezonu (posiadanie, podania, strzały, odbiory, faule, rożne, minuty goli, rodzaje goli, ustawienia taktyczne) z pozycją na tle ligi, etykiety stylu oraz automatycznie wyliczone mocne i słabe strony.
- **Opis stylu gry (AI):** model Nemotron opisuje styl na podstawie tych statystyk, bez prognoz.
- **Porównanie drużyn** i zestawienie stylów przed meczem, tabele U siebie / Na wyjeździe / Forma, rankingi strzelców, asyst i kartek.
- **Na żywo:** auto-odświeżanie, szacowana minuta, opcjonalne powiadomienia Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, test: `/api/telegram-test`).
- **PWA:** manifest, service worker (API nie jest cache'owane), ikony. `/api/tick` budzi serwis (`deploy/tick.yml.example` – opcjonalny ping z GitHub Actions).
