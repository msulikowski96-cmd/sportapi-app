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


## Nowe funkcje (listopad 2026)
- **Model statystyczny (Poisson)** + backtest na sezonie + mieszanka 50/50 z AI; porównanie trafności w zakładce Trafność.
- **Typy całej kolejki** (`/api/predict-round/N`), automatyczny `/api/tick` (typy statystyczne, AI dla meczów w ciągu 72 h, rozliczenia, powiadomienia).
  Budzenie serwisu: `deploy/tick.yml.example` – skopiuj do `.github/workflows/tick.yml` (ping co 10 min w godzinach meczów; token aplikacji nie ma uprawnienia `workflow`, więc plik trzeba dodać ręcznie).
- **Tabele** U siebie / Na wyjeździe / Forma oraz **rankingi** strzelców, asyst i kartek (agregacja meczów z Transfermarkt).
- **Podgląd meczu** przed startem (`/api/preview/tm-ID`), typ AI na żądanie.
- **Na żywo**: auto-odświeżanie, szacowana minuta (Transfermarkt jej nie podaje), powiadomienia Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, test: `/api/telegram-test`).
- **PWA**: manifest, service worker (API nie jest cache'owane), ikony.
