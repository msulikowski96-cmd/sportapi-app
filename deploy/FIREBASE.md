# Wdrożenie na Firebase (Hosting + Cloud Run)

Aplikacja to serwer Node (API + pliki statyczne), więc sam Firebase Hosting nie wystarczy.
Hosting daje domenę i CDN, a serwer działa na Cloud Run (Firebase przekierowuje do niego cały ruch).
Wymagany jest plan **Blaze** (płatność za użycie, przy takim ruchu zwykle 0 zł dzięki darmowym limitom).

## Jednorazowa konfiguracja
1. Utwórz projekt na https://console.firebase.google.com i przełącz go na plan Blaze.
2. `npm i -g firebase-tools && firebase login`
3. `cp .firebaserc.example .firebaserc` i wpisz swój project ID.

## Deploy backendu (Cloud Run)
Z katalogu repozytorium (potrzebne gcloud: https://cloud.google.com/sdk):

    gcloud run deploy ekstraklasa --source . --region europe-central2 \
      --project TWOJ-PROJECT-ID --allow-unauthenticated \
      --set-env-vars RAPIDAPI_KEY=...,NVIDIA_API_KEY=...,API_FOOTBALL_KEY=...

Klucze możesz też dodać później w konsoli Cloud Run (Edit & deploy new revision → Variables).
Opcjonalnie `--min-instances 1`, żeby nie było zimnego startu (kosztuje kilka dolarów miesięcznie).
Serwis musi nazywać się `ekstraklasa` i działać w regionie `europe-central2` (tak jest w firebase.json).

## Deploy hostingu
    firebase deploy --only hosting

Adres: https://TWOJ-PROJECT-ID.web.app. Własną domenę dodasz w Firebase Console → Hosting → Add custom domain.
