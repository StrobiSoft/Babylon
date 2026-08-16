# Babylon első hitelesítési vertikális metszete – végrehajtási terv

Kiindulási commit: `429668ee3549f20d8eb219f18a8663c0d8d190df`.

Kiindulási állapot: nem volt Babylon-alkalmazáskód, architektúra- vagy tervdokumentum, illetve Babylon-teszt. A `services/zoolab-monitor` és a nem követett `services/babylon-status` külön infrastruktúra-projekt; egyik sem része ennek a munkának.

## Mérföldkövek

1. **Biztonsági szerződés:** hitelesítési állapotgép, környezeti konfiguráció, API- és adatmodell-határok rögzítése.
2. **Perzisztens backend:** tranzakciós PostgreSQL-migrációk, meghívás, e-mail-ellenőrzés, WebAuthn, PKCE/state, átlátszatlan tokenek, eszköz- és auditkezelés.
3. **Kliensfelületek:** biztonságos WebAuthn-böngészőoldalak és az üzleti logikától elválasztott minimális Flutter-kliens Android/Windows célokra.
4. **Automatizált ellenőrzés:** egység-, integrációs-, biztonsági és kliens-tesztek, típusellenőrzés, lint, formázás és build.
5. **Működési próba:** helyi PostgreSQL + SMTP + backend, teljes meghívás–passkey–munkamenet–visszavonás folyamat, újraindítás és adatmegmaradás.
6. **Átadás:** OpenAPI, reprodukálható README, biztonsági döntések és igazolt környezeti korlátok dokumentálása.

## Igazolt állapot – 2026-08-16

### 1. A teljes hitelesítési függőleges metszet működik

A valódi Playwright Chromium és CDP virtuális WebAuthn-hitelesítő használatával futó E2E-próba sikeresen végigment: **1 passed, 0 skipped (2,39 s)**. A próba valódi PostgreSQL-sémával és helyi SMTP-kézbesítéssel ellenőrizte a meghívást, az e-mailes lépést, a `navigator.credentials.create/get` műveleteket, a passkey-regisztrációt és -belépést, a PKCE-kódcserét, a tokenforgatást, a backend újraindítását és adatmegmaradását, valamint az eszköz-visszavonást.

A korábbi csendes kihagyás megszűnt: `RUN_WEBAUTHN_E2E=1` mellett a hiányzó `TEST_DATABASE_URL` vagy `PLAYWRIGHT_CHROMIUM_EXECUTABLE` többé nem eredményezhet sikeresnek látszó `skipped` futást, hanem egyértelmű konfigurációs hibát ad. A javítás a `main` és az `origin/main` ág része:

- commit: `a6dc3b524193e93b4f4d1f28bf82c5d9c8241c0d`
- commitüzenet: `test: prevent silent WebAuthn E2E skips`

Ez igazolja a terv 2., 4. és 5. mérföldkövének hitelesítési magját; a teljes projektátadás és a produkciós környezet kialakítása ettől még külön feladat.

### 2. A közvetlen távoli fejlesztési munkafolyamat használható

A Babylon VM már meglévő `babylon-codex` SSH-kapcsolata és a `/srv/babylon/babylon-project` távoli projekt a ChatGPT/Codex asztali alkalmazásban működőképesnek bizonyult. A távoli Codex parancs a bejelentkezési környezetben a `/home/codex/.local/bin/codex` útvonalon érhető el.

A rendes fejlesztési útvonal ezért közvetlenül a Babylon VM-re vezet: a forrásmódosítás, a célhoz kötött tesztelés, a commit és a push a távoli projektben történik. A Pepper konzolja nem része a szokásos fejlesztési folyamatnak; csak tényleges hozzáférési vagy infrastruktúrahiba esetén szükséges.

### Munkaszabály

A tervezett módosítás után az elfogadási feltételt igazoló eredményt ellenőrizzük. További hibakeresési vagy diagnosztikai kör csak akkor indul, ha az eredmény hibás, hiányos vagy gyanús. Az ellenőrzések számának csökkentése nem csökkenti a dokumentáció részletességét: minden érdemi munkafázisnál rögzíteni kell a változtatásokat, a tényleges teszteredményt, a commitot, a push állapotát és az esetleges fennmaradó valódi problémákat.

## Döntések

- A Babylon Project izolált monorepója a `babylon-project/`; az infrastruktúra-szolgáltatásokat nem importálja és nem módosítja.
- A hozzáférési és frissítőtokenek átlátszatlanok és csak SHA-256 kivonattal kerülnek PostgreSQL-be. Minden védett kérés adatbázisban ellenőrzi a munkamenet és az eszköz aktív állapotát, így a visszavonás azonnali.
- A WebAuthn-folyamatot a karbantartott `@simplewebauthn/server` könyvtár ellenőrzi; user verification kötelező, attesztáció `none`, a passkeyk felfedezhetők.
- A natív kliens csak előre konfigurált visszatérési profilt használ; PKCE S256 és nagy entrópiájú `state` kötelező. Token nem kerül URL-be.
- Minden egyszer használható jogosultságot tranzakció és sorzár véd; nyers titkos érték nem kerül adatbázisba vagy naplóba.
- A tesztelhető időfüggéshez befecskendezhető óra, a tokenekhez befecskendezhető biztonságos véletlenforrás tartozik.
