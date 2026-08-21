# Babylon Project

Az Android–Windows Babylon kliens és a hitelesítési backend első működő függőleges metszete. A projekt a meghívásos regisztrációtól az e-mail-ellenőrzésen és szabványos WebAuthn passkeyn át az eszközhöz kötött, azonnal visszavonható munkamenetig terjed.

Ez a könyvtár önálló Babylon-alkalmazás. Nem része és nem függ a szomszédos `services/zoolab-monitor` vagy `services/babylon-status` infrastruktúra-szolgáltatásoktól.

## Komponensek

- `backend/`: Node.js 24, szigorú TypeScript, Fastify, SimpleWebAuthn és PostgreSQL.
- `backend/migrations/`: verziózott, ellenőrzőösszeggel védett, tranzakciós migrációk.
- `backend/public/`: minimális rendszerböngészős WebAuthn-oldalak.
- `client/`: Flutter kliens Android és Windows célplatformmal; elkülönített API-, állapot- és UI-réteg.
- [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md): az aktuális, prioritásos projekt-mesterterv; csak a hátralévő munkát tartalmazza, tetején a becsült készültségi szinttel.
- `docs/AUTH_STATE_MACHINE.md`: a normatív hitelesítési állapotgép.
- `docs/ARCHITECTURE.md`: architekturális és biztonsági döntések.
- `docs/SECURITY_ARCHITECTURE.md`: threat model, lifecycle-ok, recovery és adatminimalizálás.
- `docs/openapi.yaml`: OpenAPI 3.1 API-szerződés.
- `compose.yaml`: PostgreSQL 17.10, Mailpit 1.30 és a backend helyi környezete.

## Helyi indítás Docker Compose-zal

Előfeltétel: Docker Engine Compose v2 támogatással.

```sh
cd /srv/babylon/babylon-project
cp .env.example .env
# Cseréld le az adatbázis-jelszót, az ADMIN_BOOTSTRAP_TOKEN értékét és a tőle
# független MESSAGE_DELIVERY_BINDING_SECRET értékét.
docker compose config
docker compose up --build -d
docker compose ps
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
```

A Mailpit fejlesztői felülete: `http://127.0.0.1:8025`. A backend migrációt futtat indulás előtt. Leállítás adatmegőrzéssel: `docker compose down`; a helyi adatvolume törlése csak tudatosan, a `docker compose down -v` paranccsal történjen.

A példakonfiguráció `NODE_ENV=development`, mert a loopback HTTP-kivétel kizárólag helyi fejlesztésre szolgál. Produkcióban állítsd `production` értékre, és válts HTTPS backend-, WebAuthn- és visszatérési profilokra; az induláskori validáció más konfigurációt elutasít.

Az alapértelmezett visszatérési profil a Flutter Windows localhost figyelőjére mutat: `http://127.0.0.1:43821/callback`. A profil szerveroldalon rögzített, a kliens nem adhat tetszőleges visszatérési URL-t.

## Backend futtatása Compose nélkül

Node.js 24 és PostgreSQL 17 szükséges. A Mailpit vagy más, kizárólag helyi SMTP-tesztkiszolgáló fusson a konfigurált címen.

```sh
cd /srv/babylon/babylon-project
npm ci
cp .env.example .env
npm run migrate
npm run build
npm start
```

Fejlesztői figyelő: `npm run dev`. Az adminmeghívó létrehozása például:

```sh
curl -i -X POST http://localhost:3000/api/v1/admin/invitations \
  -H 'Authorization: Bearer A_SAJAT_BOOTSTRAP_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"email":"teszt@example.test"}'
```

A nyers meghívókód kizárólag ebben a létrehozási válaszban jelenik meg. A regisztrációs kliens előbb `native-auth/start` tranzakciót nyit, majd a kódot, e-mailt, tranzakciótokent és `state` értéket együtt küldi az `accept-invitation` végpontra. A teljes protokollt az OpenAPI és az állapotgép írja le.

## Flutter kliens

```sh
cd /srv/babylon/babylon-project/client
flutter pub get
flutter analyze
flutter test
flutter run -d windows --dart-define=BABYLON_BACKEND_URL=http://localhost:3000
```

Android emulátoron a host backend jellemző címe `http://10.0.2.2:3000`; ezt `--dart-define=BABYLON_BACKEND_URL=...` kapcsolóval add meg. A hozzáférési token csak memóriában él, a frissítőtoken és a klienseszköz kulcsa `flutter_secure_storage` mögött, az operációs rendszer védett tárhelyére kerül. A kliens egyszerre csak egy tokenfrissítést indít.

## Ellenőrzések

Az integrációs tesztek külön, eldobható PostgreSQL-adatbázist várnak; éles adatbázist ne adj meg.

```sh
cd /srv/babylon/babylon-project
npm run format:check
npm run lint
npm run check
npm run build
TEST_DATABASE_URL=postgresql://babylon_test@127.0.0.1:55432/babylon_test npm test
npm audit --audit-level=low

cd client
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

A valódi böngészős E2E-próba Playwright Chromiumot és CDP virtuális WebAuthn-hitelesítőt használ:

```sh
RUN_WEBAUTHN_E2E=1 \
TEST_DATABASE_URL=postgresql://babylon_test@127.0.0.1:55432/babylon_test \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/abszolut/ut/chrome \
npx vitest run backend/test/webauthn.e2e.test.ts
```

A próba valódi PostgreSQL-sémát, helyi SMTP-kézbesítést, `navigator.credentials.create/get` műveleteket, PKCE-kódcserét, tokenforgatást, kijelentkezést, újrabelépést, backend-újraindítást, adatmegmaradást és eszköz-visszavonást ellenőriz.

## Produkciós követelmények

- A backend nyilvános URL-je, WebAuthn-originje és minden alkalmazás-visszatérési profil kizárólag HTTPS legyen. HTTP csak `localhost`/loopback fejlesztői profilnál engedett.
- Az Android App Linkshez Digital Asset Links, Windowshoz a választott HTTPS alkalmazáshivatkozási mechanizmus és platformonként külön allowlistelt profil szükséges.
- A bootstrap tokent titokkezelőből kell beadni és rendszeresen forgatni. A példafájl nem tartalmaz éles titkot.
- Az SMTP-kiszolgálót produkcióban hitelesített, TLS-védett belső szolgáltatásra kell cserélni; a Compose Mailpit kizárólag fejlesztői eszköz.
- A TLS-terminálást, DNS-t, tanúsítványt, mobil-áruház telepítést és általános jogosultsági rendszert ez a metszet szándékosan nem valósítja meg.
