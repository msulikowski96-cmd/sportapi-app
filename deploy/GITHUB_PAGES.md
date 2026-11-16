# Wdrożenie na GitHub Pages

GitHub Pages serwuje tylko pliki statyczne, nie uruchamia `server.js`. Dlatego:

- **wygląd strony** (`index.html`, ikony, `sw.js`, `manifest.webmanifest`) jest na GitHub Pages:
  https://msulikowski96-cmd.github.io/sportapi-app/
- **dane** (`/api/...`) strona pobiera z serwera na Render: https://sportapi-app.onrender.com
  (`index.html` sam to wykrywa: na adresie `*.github.io` używa serwera Render, w innym wypadku tego samego adresu).

Serwer na Render musi więc dalej działać. Gdy Render śpi, pierwsze wczytanie danych trwa do ok. minuty.

## Jednorazowa konfiguracja
1. Wejdź na https://github.com/msulikowski96-cmd/sportapi-app/settings/pages
2. **Source**: „Deploy from a branch”.
3. **Branch**: `main`, folder `/ (root)` → **Save**.
4. Po 1–2 minutach strona będzie pod https://msulikowski96-cmd.github.io/sportapi-app/
   (postęp wdrożenia: zakładka **Actions** → „pages build and deployment”).

## Kolejne wdrożenia
Nic nie trzeba robić: każdy push na `main` aktualizuje jednocześnie Render (serwer) i GitHub Pages (stronę).

## Jak to jest przygotowane w kodzie
- `index.html`: stała `API_BASE` (adres serwera dla `*.github.io`), ścieżki do plików względne.
- `sw.js`, `manifest.webmanifest`: ścieżki względne, więc działają też w podkatalogu `/sportapi-app/`.
- `server.js`: nagłówek `Access-Control-Allow-Origin: *` w odpowiedziach API (strona z innej domeny może pobierać dane).
- `.nojekyll`: GitHub nie przetwarza plików Jekyllem.

## Własna domena (opcjonalnie)
Settings → Pages → **Custom domain**, np. `ekstraklasa.twojadomena.pl`, a u rejestratora domeny rekord
`CNAME` wskazujący na `msulikowski96-cmd.github.io`. Potem zaznacz **Enforce HTTPS**.
Jeśli zmienisz adres serwera na Render, popraw `API_BASE` w `index.html`.

## Uwagi
- Repozytorium musi być publiczne (na darmowym planie GitHub Pages nie działa z prywatnymi). Jest publiczne.
- Na GitHub Pages trafiają wszystkie pliki z repozytorium (także `server.js` i `fmv-values.json`). Klucze API są tylko
  w zmiennych środowiskowych Render, więc nic tajnego nie wycieka.
